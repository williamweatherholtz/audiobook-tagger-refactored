import { callBackend, subscribe } from '../api';

export function useMetadataHandlers({ groups, setGroups, selectedGroupIds, allSelected, batch, config, toast, getSelectedCount, gatheredDataRef }) {
  const { forceFresh } = batch;

  const handleFixTitles = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('titles', { total: selectedGroups.length });

    let successCount = 0;
    let failedCount = 0;

    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      batch.update('titles', { current: i, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') });

      const results = await Promise.allSettled(
        chunk.map(async (group) => {
          try {
            const folderPath = group.files?.[0]?.path?.split('/').slice(0, -1).join('/')
              || group.metadata?.source_path
              || null;
            const result = await callBackend('resolve_title', {
              request: {
                filename: group.files?.[0]?.filename || null,
                folder_name: group.group_name,
                folder_path: folderPath,
                current_title: group.metadata?.title || '',
                current_author: group.metadata?.author || '',
                current_series: group.metadata?.series || null,
                current_sequence: group.metadata?.sequence || null,
                additional_context: null
              }
            });
            return { groupId: group.id, result };
          } catch (err) {
            console.error(`Failed to fix title for ${group.group_name}:`, err);
            return { groupId: group.id, error: err };
          }
        })
      );

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (batchResult && batchResult.status === 'fulfilled') {
            const { result } = batchResult.value;
            if (result.success && result.result) {
              const r = result.result;
              successCount++;

              if (r.confidence < 70 && r.suggested_title) {
              }

              const useTitle = (r.confidence < 50 && r.suggested_title) ? r.suggested_title : r.title;
              const useAuthor = (r.confidence < 50 && r.suggested_author) ? r.suggested_author : (r.author || g.metadata.author);

              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  title: useTitle || g.metadata.title,
                  author: useAuthor || g.metadata.author,
                  subtitle: r.subtitle || g.metadata.subtitle,
                  title_suggestion: r.suggested_title || null,
                  author_suggestion: r.suggested_author || null,
                  suggestion_source: r.suggestion_source || null,
                  title_confidence: r.confidence,
                },
                total_changes: (g.total_changes || 0) + 1,
              };
            } else {
              failedCount++;
            }
          }
          return g;
        });
      });

      batch.update('titles', {
        current: Math.min(i + batchSize, selectedGroups.length),
        success: successCount,
        failed: failedCount,
      });
    }

    batch.end('titles');
  };

  const handleFixSubtitles = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('subtitles', { total: selectedGroups.length, fixed: 0, skipped: 0 });

    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    let subtitleChunkOffset = 0;
    const unlistenSubtitles = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'subtitles') return;
      batch.update('subtitles', { current: subtitleChunkOffset + d.current, currentBook: d.title });
    });

    const batchSize = 10;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      subtitleChunkOffset = i;
      batch.update('subtitles', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          author: g.metadata?.author || '',
          current_subtitle: g.metadata?.subtitle || null,
        }));

        const result = await callBackend('fix_subtitles_batch', { books, config, force: forceFresh });

        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const subResult = result.results.find(r => r.id === g.id);
              if (!subResult || !subResult.fixed || !subResult.subtitle) return g;
              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  subtitle: subResult.subtitle,
                },
                total_changes: (g.total_changes || 0) + 1,
              };
            });
          });

          fixedCount += result.total_fixed;
          skippedCount += result.total_skipped;
          failedCount += result.total_failed;
        }

        batch.update('subtitles', {
          current: Math.min(i + batchSize, selectedGroups.length),
          fixed: fixedCount,
          skipped: skippedCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('subtitles', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }

    unlistenSubtitles();
    batch.end('subtitles', 1500);
  };

  const handleFixAuthors = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('authors', { total: selectedGroups.length, fixed: 0, skipped: 0 });

    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    let authorChunkOffset = 0;
    const unlistenAuthors = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'authors') return;
      batch.update('authors', { current: authorChunkOffset + d.current, currentBook: d.title });
    });

    const batchSize = 10;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      authorChunkOffset = i;
      batch.update('authors', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          current_author: g.metadata?.author || '',
        }));

        const result = await callBackend('fix_authors_batch', { books, config, force: forceFresh });

        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const authResult = result.results.find(r => r.id === g.id);
              if (!authResult || !authResult.fixed || !authResult.author) return g;
              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  author: authResult.author,
                },
                total_changes: (g.total_changes || 0) + 1,
              };
            });
          });

          fixedCount += result.total_fixed;
          skippedCount += result.total_skipped;
          failedCount += result.total_failed;
        }

        batch.update('authors', {
          current: Math.min(i + batchSize, selectedGroups.length),
          fixed: fixedCount,
          skipped: skippedCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('authors', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }

    unlistenAuthors();
    batch.end('authors', 1500);
  };

  const handleFixYears = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('years', { total: selectedGroups.length, fixed: 0, skipped: 0 });

    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    let yearChunkOffset = 0;
    const unlistenYears = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'years') return;
      batch.update('years', { current: yearChunkOffset + d.current, currentBook: d.title });
    });

    const batchSize = 50;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      yearChunkOffset = i;
      batch.update('years', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => {
          const gathered = gatheredDataRef.current?.get(g.id);
          return {
            id: g.id,
            title: g.metadata?.title || '',
            author: g.metadata?.author || '',
            current_year: g.metadata?.year || null,
            series: g.metadata?.series || null,
            description: g.metadata?.description || null,
            ol_year: gathered?.ol_year || null,
            ol_date: gathered?.ol_date || null,
            gb_year: gathered?.gb_year || null,
            gb_date: gathered?.gb_date || null,
            provider_year: gathered?.provider_year || null,
          };
        });

        const result = await callBackend('fix_years_batch', { books, config, force: forceFresh });

        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const yearResult = result.results.find(r => r.id === g.id);
              if (!yearResult || !yearResult.year) return g;

              let newTags = g.metadata?.tags || [];
              if (yearResult.pub_tag) {
                newTags = newTags.filter(t => !t.startsWith('pub-'));
                newTags.push(yearResult.pub_tag);
              }

              if (!yearResult.fixed) return {
                ...g,
                metadata: { ...g.metadata, tags: newTags },
              };

              const fields = new Set(g.changedFields || []);
              fields.add('year');
              if (yearResult.pub_tag) fields.add('tags');
              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  year: yearResult.year,
                  tags: newTags,
                },
                total_changes: (g.total_changes || 0) + 1,
                changedFields: [...fields],
              };
            });
          });

          fixedCount += result.total_fixed;
          skippedCount += result.total_skipped;
          failedCount += result.total_failed;
        }

        batch.update('years', {
          current: Math.min(i + batchSize, selectedGroups.length),
          fixed: fixedCount,
          skipped: skippedCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('years', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }

    unlistenYears();
    batch.end('years', 1500);
  };

  const handleFixSeries = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('series', { total: selectedGroups.length });

    let successCount = 0;
    let failedCount = 0;

    const batchSize = 3;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      batch.update('series', { current: i, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') });

      const results = await Promise.allSettled(
        chunk.map(async (group) => {
          try {
            const result = await callBackend('resolve_series', {
              request: {
                title: group.metadata?.title || group.group_name,
                author: group.metadata?.author || '',
                current_series: group.metadata?.series || null,
                current_sequence: group.metadata?.sequence || null,
              }
            });
            return { groupId: group.id, result };
          } catch (err) {
            console.error(`Failed to fix series for ${group.group_name}:`, err);
            return { groupId: group.id, error: err };
          }
        })
      );

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (batchResult && batchResult.status === 'fulfilled') {
            const { result } = batchResult.value;
            if (result.success && result.result) {
              const r = result.result;
              successCount++;
              const newSeries = r.series || g.metadata.series;
              const newSequence = r.sequence || g.metadata.sequence;
              const newAllSeries = newSeries
                ? [{ name: newSeries, sequence: newSequence }, ...(g.metadata.all_series || []).filter(s => s.name !== newSeries).slice(0)]
                : g.metadata.all_series;
              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  series: newSeries,
                  sequence: newSequence,
                  all_series: newAllSeries,
                },
                total_changes: (g.total_changes || 0) + 1,
              };
            } else {
              failedCount++;
            }
          }
          return g;
        });
      });

      batch.update('series', {
        current: Math.min(i + batchSize, selectedGroups.length),
        success: successCount,
        failed: failedCount,
      });
    }

    batch.end('series');
  };

  const handleMetadataResolution = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    const needsMetadata = (g) => {
      const m = g.metadata || {};
      if (!m.title || !m.author) return true;
      if (/\.\w{2,4}$/.test(m.title) || m.title.includes('_')) return true;
      if (m.author.includes('/') || m.author.includes('\\') || m.author.toLowerCase() === 'unknown') return true;
      if (!m.series && /book\s*\d|vol/i.test(g.group_name || '')) return true;
      if (!m.subtitle) return true;
      return false;
    };

    const booksToProcess = forceFresh ? selectedGroups : selectedGroups.filter(needsMetadata);
    const skipped = selectedGroups.length - booksToProcess.length;

    if (booksToProcess.length === 0) {
      toast.success('Metadata Resolution', 'All selected books already have complete metadata');
      return;
    }

    batch.start('metadata', { total: booksToProcess.length, currentBook: 'Resolving metadata via ABS + GPT...' });

    const books = booksToProcess.map(g => {
      const gathered = gatheredDataRef.current?.get(g.id);
      return {
        id: g.id,
        filename: g.files?.[0]?.filename || null,
        folder_name: g.group_name || null,
        folder_path: g.files?.[0]?.path?.split('/').slice(0, -1).join('/') || g.metadata?.source_path || null,
        current_title: g.metadata?.title || '',
        current_author: g.metadata?.author || '',
        current_subtitle: g.metadata?.subtitle || null,
        current_series: g.metadata?.series || null,
        current_sequence: g.metadata?.sequence || null,
        audible_title: gathered?.abs_title || null,
        audible_author: gathered?.abs_author || null,
        audible_subtitle: gathered?.abs_subtitle || null,
        audible_series: gathered?.abs_series || null,
        audible_sequence: gathered?.abs_sequence || null,
        file_tags: g.file_enrichment?.file_tags || null,
        transcripts: g.file_enrichment?.transcripts || null,
      };
    });

    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'metadata') return;
      batch.update('metadata', { current: d.current, currentBook: d.title });
    });

    try {
      const result = await callBackend('resolve_metadata_batch', { books, config });

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const r = result.results?.find(r => r.id === g.id);
          if (!r || r.error || !r.changed) return g;
          const fields = new Set(g.changedFields || []);
          if (r.title && r.title !== g.metadata.title) fields.add('title');
          if (r.author && r.author !== g.metadata.author) fields.add('author');
          if (r.subtitle && r.subtitle !== g.metadata.subtitle) fields.add('subtitle');
          if (r.series !== undefined && r.series !== g.metadata.series) fields.add('series');
          if (r.sequence !== undefined && r.sequence !== g.metadata.sequence) fields.add('sequence');
          if (r.narrator && r.narrator !== g.metadata.narrator) fields.add('narrator');
          return {
            ...g,
            metadata: {
              ...g.metadata,
              title: r.title || g.metadata.title,
              author: r.author || g.metadata.author,
              subtitle: r.subtitle || g.metadata.subtitle,
              series: r.series !== undefined ? r.series : g.metadata.series,
              sequence: r.sequence !== undefined ? r.sequence : g.metadata.sequence,
              narrator: r.narrator || g.metadata.narrator,
            },
            total_changes: (g.total_changes || 0) + 1,
            changedFields: [...fields],
          };
        });
      });

      unlisten();
      const processed = result.total_processed || 0;
      const failed = result.total_failed || 0;
      batch.update('metadata', { current: booksToProcess.length, success: processed, failed, currentBook: 'Complete' });
      if (processed > 0 || skipped > 0) {
        const parts = [];
        if (processed > 0) parts.push(`${processed} resolved`);
        if (skipped > 0) parts.push(`${skipped} already ok`);
        if (failed > 0) parts.push(`${failed} failed`);
        toast.success('Metadata Resolution Complete', parts.join(', '));
      }
    } catch (e) {
      unlisten();
      console.error('Metadata resolution error:', e);
      toast.error('Metadata Resolution Failed', e.toString());
    }
    batch.end('metadata', 2000);
  };

  const handleDescriptionProcessing = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    const needsDescription = (g) => {
      const desc = g.metadata?.description;
      if (!desc) return true;
      if (desc.trim().length < 50) return true;
      if (/^(no description|description not available|n\/a|none|unknown|tbd)/i.test(desc.trim())) return true;
      if (/<[^>]+>/.test(desc)) return true;
      return false;
    };

    const booksToProcess = forceFresh ? selectedGroups : selectedGroups.filter(needsDescription);
    const skippedDesc = selectedGroups.length - booksToProcess.length;

    if (booksToProcess.length === 0) {
      toast.success('Description Processing', 'All selected books already have good descriptions');
      return;
    }

    batch.start('descriptionProcessing', { total: booksToProcess.length, currentBook: 'Processing descriptions...' });

    const books = booksToProcess.map(g => ({
      id: g.id,
      title: g.metadata?.title || '',
      author: g.metadata?.author || '',
      genres: g.metadata?.genres || [],
      description: g.metadata?.description || null,
    }));

    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'description') return;
      batch.update('descriptionProcessing', { current: d.current, currentBook: d.title });
    });

    try {
      const result = await callBackend('process_descriptions_batch', { books, config });

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const r = result.results?.find(r => r.id === g.id);
          if (!r || r.error || !r.changed) return g;

          const narratorMatch = r.description?.match(/(?:read|narrated|voiced|performed)\s+by\s+([A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+)*)/i);

          const fields = new Set(g.changedFields || []);
          fields.add('description');
          if (narratorMatch && !g.metadata.narrator) fields.add('narrator');

          return {
            ...g,
            metadata: {
              ...g.metadata,
              description: r.description,
              ...(narratorMatch && !g.metadata.narrator ? { narrator: narratorMatch[1] } : {}),
            },
            total_changes: (g.total_changes || 0) + 1,
            changedFields: [...fields],
          };
        });
      });

      const processed = result.total_processed || 0;
      const failed = result.total_failed || 0;
      unlisten();
      batch.update('descriptionProcessing', { current: booksToProcess.length, success: processed, failed, currentBook: 'Complete' });
      if (processed > 0 || skippedDesc > 0) {
        const parts = [];
        if (processed > 0) parts.push(`${processed} processed`);
        if (skippedDesc > 0) parts.push(`${skippedDesc} already ok`);
        if (failed > 0) parts.push(`${failed} failed`);
        toast.success('Description Processing Complete', parts.join(', '));
      }
    } catch (e) {
      unlisten();
      console.error('Description processing error:', e);
      toast.error('Description Processing Failed', e.toString());
    }
    batch.end('descriptionProcessing', 2000);
  };

  return {
    handleFixTitles,
    handleFixSubtitles,
    handleFixAuthors,
    handleFixYears,
    handleFixSeries,
    handleMetadataResolution,
    handleDescriptionProcessing,
  };
}
