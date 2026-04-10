import { callBackend, subscribe } from '../api';

export function useClassifyHandlers({ groups, setGroups, selectedGroupIds, allSelected, batch, config, toast, getSelectedCount, handleCleanupGenres }) {
  const { forceFresh, dnaEnabled } = batch;

  const handleGenreCleanup = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0 && !allSelected) return;

    const hasAnyAI = !!(config?.openai_api_key || config?.anthropic_api_key || config?.use_local_ai || config?.use_claude_cli);
    if (!hasAnyAI) {
      try {
        const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
        await handleCleanupGenres(selectedGroups);
      } catch (error) {
        console.error('Genre cleanup failed:', error);
      }
      return;
    }

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('genres', { total: selectedGroups.length, cleaned: 0, unchanged: 0 });

    let cleanedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;

    let chunkOffset = 0;
    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'genres') return;
      batch.update('genres', { current: chunkOffset + d.current, currentBook: d.title });
    });

    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      chunkOffset = i;
      batch.update('genres', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          author: g.metadata?.author || '',
          genres: g.metadata?.genres || [],
          description: g.metadata?.description || null,
        }));

        const result = await callBackend('cleanup_genres_with_gpt', { books, config });

        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const genreResult = result.results.find(r => r.id === g.id);
              if (genreResult && genreResult.changed) {
                return {
                  ...g,
                  metadata: {
                    ...g.metadata,
                    genres: genreResult.cleaned_genres,
                  },
                  total_changes: (g.total_changes || 0) + 1,
                };
              }
              return g;
            });
          });

          cleanedCount += result.total_cleaned;
          unchangedCount += result.total_unchanged;
          failedCount += result.total_failed;
        }

        batch.update('genres', {
          current: Math.min(i + batchSize, selectedGroups.length),
          cleaned: cleanedCount,
          unchanged: unchangedCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('genres', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }

    unlisten();
    batch.end('genres', 1500);
  };

  const handleAssignTagsGpt = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('tags', { total: selectedGroups.length });

    let successCount = 0;
    let failedCount = 0;

    let tagChunkOffset = 0;
    const unlistenTags = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'tags') return;
      batch.update('tags', { current: tagChunkOffset + d.current, currentBook: d.title });
    });

    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      tagChunkOffset = i;
      batch.update('tags', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          author: g.metadata?.author || '',
          genres: g.metadata?.genres || [],
          description: g.metadata?.description || null,
          duration_minutes: g.metadata?.runtime_minutes || null,
        }));

        const result = await callBackend('assign_tags_with_gpt', { books, config, dnaEnabled });

        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const tagResult = result.results.find(r => r.id === g.id);
              if (tagResult && tagResult.suggested_tags && tagResult.suggested_tags.length > 0) {
                return {
                  ...g,
                  metadata: {
                    ...g.metadata,
                    tags: tagResult.suggested_tags,
                  },
                  total_changes: (g.total_changes || 0) + 1,
                };
              }
              return g;
            });
          });

          successCount += result.total_processed;
          failedCount += result.total_failed;
        }

        batch.update('tags', {
          current: Math.min(i + batchSize, selectedGroups.length),
          success: successCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('tags', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }

    unlistenTags();

    batch.update('tags', { currentBook: 'Looking up age ratings...' });

    const ageBatchSize = 3;
    for (let i = 0; i < selectedGroups.length; i += ageBatchSize) {
      const chunk = selectedGroups.slice(i, i + ageBatchSize);
      batch.update('tags', { currentBook: `Age: ${chunk.map(g => g.metadata?.title || g.group_name).join(', ')}` });

      const ageResults = await Promise.allSettled(
        chunk.map(async (group) => {
          try {
            const result = await callBackend('resolve_book_age_rating', {
              request: {
                title: group.metadata?.title || group.group_name,
                author: group.metadata?.author || '',
                series: group.metadata?.series || null,
                description: group.metadata?.description || null,
                genres: group.metadata?.genres || [],
                publisher: group.metadata?.publisher || null,
              }
            });
            return { groupId: group.id, result };
          } catch (err) {
            console.error(`Age lookup failed for ${group.group_name}:`, err);
            return { groupId: group.id, result: { success: false } };
          }
        })
      );

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const ageResult = ageResults.find(r =>
            r.status === 'fulfilled' && r.value.groupId === g.id
          );
          if (ageResult && ageResult.status === 'fulfilled') {
            const { result } = ageResult.value;
            if (result.success && result.age_tags && result.age_tags.length > 0) {
              const existingTags = g.metadata?.tags || [];
              const newTags = [...existingTags];
              for (const tag of result.age_tags) {
                if (!newTags.includes(tag)) {
                  newTags.push(tag);
                }
              }
              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  tags: newTags,
                  age_rating: result.age_category,
                  content_rating: result.content_rating,
                },
              };
            }
          }
          return g;
        });
      });
    }

    batch.end('tags', 1500);
  };

  const handleGenerateDna = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('dna', { total: selectedGroups.length });

    const items = selectedGroups.map(g => ({
      id: g.id,
      title: g.metadata?.title || '',
      author: g.metadata?.author || '',
      description: g.metadata?.description || null,
      genres: g.metadata?.genres || [],
      tags: g.metadata?.tags || [],
      narrator: g.metadata?.narrator || null,
      duration_minutes: g.metadata?.runtime_minutes || null,
      series_name: g.metadata?.series || null,
      series_sequence: g.metadata?.sequence || null,
      year: g.metadata?.year || null,
    }));

    let dnaSuccessCount = 0;
    let dnaFailedCount = 0;

    try {
      const unlisten = subscribe('dna-progress', (data) => {
        const { current, total, title, success, error, processing } = data;
        if (!processing) {
          if (success) dnaSuccessCount++;
          else dnaFailedCount++;
        }
        batch.update('dna', {
          current,
          total,
          success: dnaSuccessCount,
          failed: dnaFailedCount,
          currentBook: title,
        });

        if (error) {
          console.warn(`DNA generation failed for "${title}": ${error}`);
        }
      });

      const results = await callBackend('generate_book_dna_batch', {
        request: { items },
      });

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const result = results.find(r => r.id === g.id);
          if (result && result.success) {
            return {
              ...g,
              metadata: {
                ...g.metadata,
                tags: result.merged_tags,
              },
              total_changes: (g.total_changes || 0) + 1,
            };
          }
          return g;
        });
      });

      unlisten();

      const successCount = results.filter(r => r.success).length;
      const failedCount = results.filter(r => !r.success).length;

      if (successCount > 0) {
        toast.success('BookDNA Generated', `Generated DNA fingerprints for ${successCount} book${successCount > 1 ? 's' : ''}`);
      }

    } catch (error) {
      console.error('BookDNA generation failed:', error);
      toast.error('DNA Generation Failed', error.toString());
    }

    batch.end('dna', 1500);
  };

  const handleClassifyAll = async (includeDescription = true) => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    const needsClassification = (g) => {
      const m = g.metadata || {};
      if (!m.genres || m.genres.length === 0) return true;
      if (!m.tags || m.tags.length === 0) return true;
      const hasAgeTags = (m.tags || []).some(t => /^age-|^for-kids$|^for-teens$|^for-ya$|^not-for-kids$|^rated-/i.test(t));
      if (!hasAgeTags) return true;
      const hasDnaTags = (m.tags || []).some(t => t.startsWith('dna:'));
      if (!hasDnaTags) return true;
      return false;
    };

    const booksToProcess = forceFresh ? selectedGroups : selectedGroups.filter(needsClassification);
    const skippedClassify = selectedGroups.length - booksToProcess.length;

    if (booksToProcess.length === 0) {
      toast.success('Classification', 'All selected books already classified');
      return;
    }

    if (forceFresh) {
      const idsToProcess = new Set(booksToProcess.map(g => g.id));
      setGroups(prev => prev.map(g => {
        if (!idsToProcess.has(g.id)) return g;
        const m = { ...g.metadata };
        m.genres = [];
        m.tags = [];
        m.themes = [];
        m.tropes = [];
        return { ...g, metadata: m, changedFields: [] };
      }));
    }

    batch.start('classify', { total: booksToProcess.length, currentBook: 'Starting classification...' });

    const books = booksToProcess.map(g => ({
      id: g.id,
      title: g.metadata?.title || '',
      author: g.metadata?.author || '',
      description: g.metadata?.description || null,
      genres: g.metadata?.genres || [],
      tags: g.metadata?.tags || [],
      duration_minutes: g.metadata?.runtime_minutes || null,
      narrator: g.metadata?.narrator || null,
      series_name: g.metadata?.series || null,
      series_sequence: g.metadata?.sequence || null,
      year: g.metadata?.year || null,
      publisher: g.metadata?.publisher || null,
      file_enrichment: g.file_enrichment || null,
    }));

    const unlisten = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'classify') return;
      batch.update('classify', { current: d.current, currentBook: d.title });
    });

    try {
      const result = await callBackend('classify_books_batch', {
        books,
        includeDescription,
        forceFresh,
        dnaEnabled,
        config,
      });

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const r = result.results?.find(r => r.id === g.id);
          if (!r || r.error) return g;

          const updatedMeta = { ...g.metadata };

          if (r.genres?.length > 0) updatedMeta.genres = r.genres;

          const existingDnaTags = (r.dna_tags?.length > 0)
            ? []
            : (g.metadata?.tags || []).filter(t => t.startsWith('dna:'));
          const allTags = new Set([
            ...existingDnaTags,
            ...(r.tags || []),
            ...(r.dna_tags || []),
            ...(r.age_tags || []),
          ]);
          updatedMeta.tags = [...allTags];

          if (r.themes?.length > 0) updatedMeta.themes = r.themes;
          if (r.tropes?.length > 0) updatedMeta.tropes = r.tropes;

          if (r.description && r.description_changed) {
            updatedMeta.description = r.description;
          }

          const fields = new Set(g.changedFields || []);
          if (r.genres?.length > 0) fields.add('genres');
          if (allTags.size > 0) fields.add('tags');
          if (r.themes?.length > 0) fields.add('themes');
          if (r.tropes?.length > 0) fields.add('tropes');
          if (r.description && r.description_changed) fields.add('description');
          if (r.age_category && r.age_category !== 'Unknown') fields.add('age');
          if (r.dna_tags?.length > 0) fields.add('dna');

          return {
            ...g,
            metadata: updatedMeta,
            total_changes: (g.total_changes || 0) + 1,
            changedFields: [...fields],
          };
        });
      });

      unlisten();
      const successCount = result.total_processed || 0;
      const failedCount = result.total_failed || 0;

      batch.update('classify', { current: booksToProcess.length, success: successCount, failed: failedCount, currentBook: 'Complete!' });

      if (failedCount > 0 && successCount === 0) {
        const firstError = result.results?.find(r => r.error)?.error;
        const detail = firstError ? `First error: ${firstError}` : `${failedCount} books failed — check Logs panel for details`;
        toast.error('Classification Failed', detail, 10000);
      } else if (successCount > 0 || skippedClassify > 0) {
        const cParts = [];
        if (successCount > 0) cParts.push(`${successCount} classified`);
        if (skippedClassify > 0) cParts.push(`${skippedClassify} already ok`);
        if (failedCount > 0) cParts.push(`${failedCount} failed — see Logs`);
        toast.success('Classification Complete', cParts.join(', '));
      }

    } catch (error) {
      unlisten();
      console.error('Classification failed:', error);
      toast.error('Classification Failed', String(error), 10000);
    }

    batch.end('classify', 1500);
  };

  const handleFixDescriptionsGpt = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('descriptions', { total: selectedGroups.length, fixed: 0, skipped: 0 });

    let fixedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    let descChunkOffset = 0;
    const unlistenDescs = subscribe('batch-progress', (d) => {
      if (d.call_type !== 'description') return;
      batch.update('descriptions', { current: descChunkOffset + d.current, currentBook: d.title });
    });

    const batchSize = 25;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      descChunkOffset = i;
      batch.update('descriptions', { current: i, currentBook: chunk.map(g => g.metadata?.title).join(', ') });

      try {
        const books = chunk.map(g => ({
          id: g.id,
          title: g.metadata?.title || '',
          author: g.metadata?.author || '',
          genres: g.metadata?.genres || [],
          description: g.metadata?.description || null,
        }));

        const result = await callBackend('fix_descriptions_with_gpt', { books, config, force: forceFresh });

        if (result.results && result.results.length > 0) {
          setGroups(prevGroups => {
            return prevGroups.map(g => {
              const descResult = result.results.find(r => r.id === g.id);
              if (!descResult) return g;

              let changes = 0;
              const updates = {};

              if (descResult.fixed && descResult.new_description) {
                updates.description = descResult.new_description;
                changes++;
              }

              if (descResult.extracted_narrator) {
                updates.narrator = descResult.extracted_narrator;
                updates.narrators = descResult.extracted_narrator.split(';').map(n => n.trim()).filter(Boolean);
                changes++;
              }

              if (Object.keys(updates).length === 0) return g;

              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  ...updates,
                },
                total_changes: (g.total_changes || 0) + changes,
              };
            });
          });

          fixedCount += result.total_fixed;
          skippedCount += result.total_skipped;
          failedCount += result.total_failed;
        }

        batch.update('descriptions', {
          current: Math.min(i + batchSize, selectedGroups.length),
          fixed: fixedCount,
          skipped: skippedCount,
          failed: failedCount,
        });

      } catch (error) {
        console.error(`Batch ${i}-${i + batchSize} failed:`, error);
        failedCount += chunk.length;
        batch.update('descriptions', {
          current: Math.min(i + batchSize, selectedGroups.length),
          failed: failedCount,
        });
      }
    }

    unlistenDescs();
    batch.end('descriptions', 1500);
  };

  return {
    handleGenreCleanup,
    handleAssignTagsGpt,
    handleGenerateDna,
    handleClassifyAll,
    handleFixDescriptionsGpt,
  };
}
