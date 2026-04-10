import { callBackend } from '../api';

export function useEnrichmentHandlers({ groups, setGroups, selectedGroupIds, allSelected, batch, config, toast, getSelectedCount, gatheredDataRef }) {
  const { forceFresh } = batch;

  const handleLookupAge = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    batch.start('age', { total: selectedGroups.length });

    let successCount = 0;
    let failedCount = 0;

    const batchSize = 2;
    for (let i = 0; i < selectedGroups.length; i += batchSize) {
      const chunk = selectedGroups.slice(i, i + batchSize);
      batch.update('age', { current: i, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') });

      const results = await Promise.allSettled(
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
            return { groupId: group.id, result: { success: false, error: err.toString() } };
          }
        })
      );

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (batchResult && batchResult.status === 'fulfilled') {
            const { result } = batchResult.value;
            if (result.success && result.age_category) {
              successCount++;
              let newGenres = [...(g.metadata?.genres || [])];
              const ageCategory = result.age_category;

              if (ageCategory && ageCategory !== 'Adult') {
                newGenres = newGenres.filter(genre =>
                  !genre.startsWith("Children's") &&
                  genre !== "Teen 13-17" &&
                  genre !== "Young Adult" &&
                  genre !== "Middle Grade"
                );
                if (!newGenres.includes(ageCategory)) {
                  newGenres.splice(1, 0, ageCategory);
                }
              }

              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  genres: newGenres,
                  age_rating: ageCategory,
                  content_rating: result.content_rating,
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

      batch.update('age', {
        current: Math.min(i + batchSize, selectedGroups.length),
        success: successCount,
        failed: failedCount,
      });
    }

    batch.end('age');
  };

  const handleLookupISBN = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    batch.start('isbn', {});
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    const needsIsbn = (g) => {
      const m = g.metadata || {};
      if (m.isbn && m.isbn.trim().length > 0) return false;
      if (m.asin && m.asin.trim().length > 0) return false;
      return true;
    };

    const booksToProcess = forceFresh ? selectedGroups : selectedGroups.filter(needsIsbn);
    const skippedIsbn = selectedGroups.length - booksToProcess.length;

    if (booksToProcess.length === 0) {
      toast.success('ISBN Lookup', 'All selected books already have ISBN/ASIN');
      batch.end('isbn');
      return;
    }

    batch.update('isbn', { total: booksToProcess.length });

    let successCount = 0;
    let failedCount = 0;

    const batchSize = 3;
    for (let i = 0; i < booksToProcess.length; i += batchSize) {
      const chunk = booksToProcess.slice(i, i + batchSize);
      batch.update('isbn', { current: i, currentBook: chunk.map(g => g.metadata?.title || g.group_name).join(', ') });

      const results = await Promise.allSettled(
        chunk.map(async (group) => {
          try {
            const gathered = gatheredDataRef.current?.get(group.id);
            if (gathered && (gathered.isbn || gathered.asin)) {
              return { groupId: group.id, result: { success: true, isbn: gathered.isbn, asin: gathered.asin, source: 'gather-phase' } };
            }
            const result = await callBackend('lookup_book_isbn', {
              request: {
                title: group.metadata?.title || group.group_name,
                author: group.metadata?.author || '',
              }
            });
            return { groupId: group.id, result };
          } catch (err) {
            console.error(`ISBN lookup failed for ${group.group_name}:`, err);
            return { groupId: group.id, result: { success: false, error: err.toString() } };
          }
        })
      );

      setGroups(prevGroups => {
        return prevGroups.map(g => {
          const batchResult = results.find(r => r.status === 'fulfilled' && r.value.groupId === g.id);
          if (batchResult && batchResult.status === 'fulfilled') {
            const { result } = batchResult.value;
            if (result.success && (result.isbn || result.asin)) {
              successCount++;
              const fields = new Set(g.changedFields || []);
              if (result.isbn) fields.add('isbn');
              if (result.asin) fields.add('asin');
              return {
                ...g,
                metadata: {
                  ...g.metadata,
                  isbn: result.isbn || g.metadata?.isbn,
                  asin: result.asin || g.metadata?.asin,
                },
                total_changes: (g.total_changes || 0) + 1,
                changedFields: [...fields],
              };
            } else {
              failedCount++;
            }
          }
          return g;
        });
      });

      batch.update('isbn', {
        current: Math.min(i + batchSize, booksToProcess.length),
        success: successCount,
        failed: failedCount,
      });
    }

    if (successCount > 0 || skippedIsbn > 0) {
      const parts = [];
      if (successCount > 0) parts.push(`${successCount} found`);
      if (skippedIsbn > 0) parts.push(`${skippedIsbn} already had ISBN`);
      if (failedCount > 0) parts.push(`${failedCount} not found`);
      toast.success('ISBN Lookup Complete', parts.join(', '));
    }
    batch.end('isbn');
  };

  const handleReadFileTags = async () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    if (selectedGroups.length === 0) return;

    batch.start('fileTags', { total: selectedGroups.length, current: 0, success: 0, failed: 0 });

    let success = 0, failed = 0;
    for (let i = 0; i < selectedGroups.length; i++) {
      const g = selectedGroups[i];
      const title = g.metadata?.title || g.group_name || 'Untitled';
      batch.update('fileTags', { current: i + 1, currentBook: title });

      const filePaths = (g.files || []).map(f => f.path).filter(Boolean);
      if (filePaths.length === 0) { failed++; continue; }

      try {
        const tags = await callBackend('read_book_tags', { file_paths: filePaths });
        setGroups(prev => prev.map(pg => pg.id !== g.id ? pg : {
          ...pg,
          file_enrichment: { ...(pg.file_enrichment || {}), file_tags: tags },
        }));
        success++;
      } catch (err) {
        console.warn(`File tag read failed for "${title}":`, err);
        failed++;
      }
    }

    toast.success('File Tags Read', `Read tags from ${success} book${success !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}`);
    batch.end('fileTags', 1500);
  };

  const handleTranscribeAudio = async () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    if (selectedGroups.length === 0) return;

    batch.start('transcribe', { total: selectedGroups.length, current: 0, success: 0, failed: 0 });

    const transcribeConfig = {
      whisper_path: config?.whisper_path || null,
      whisper_mode: config?.whisper_mode || 'auto',
      whisper_model_name: config?.whisper_model_name || 'large-v3',
      whisper_model_path: config?.whisper_model_path || null,
      language: config?.whisper_language || 'en',
      segment_secs: config?.whisper_segment_secs || 90,
      ffmpeg_path: config?.ffmpeg_path || null,
    };

    let success = 0, failed = 0;
    for (let i = 0; i < selectedGroups.length; i++) {
      const g = selectedGroups[i];
      const title = g.metadata?.title || g.group_name || 'Untitled';
      batch.update('transcribe', { current: i + 1, currentBook: title });

      const filePaths = (g.files || []).map(f => f.path).filter(Boolean);
      if (filePaths.length === 0) { failed++; continue; }

      try {
        const result = await callBackend('transcribe_book', {
          file_paths: filePaths,
          config: transcribeConfig,
        });
        if (result.beginning || result.ending) {
          setGroups(prev => prev.map(pg => pg.id !== g.id ? pg : {
            ...pg,
            file_enrichment: {
              ...(pg.file_enrichment || {}),
              transcripts: { beginning: result.beginning, ending: result.ending },
            },
          }));
          success++;
        } else {
          failed++;
        }
      } catch (err) {
        console.warn(`Transcription failed for "${title}":`, err);
        failed++;
      }
    }

    if (success > 0) {
      toast.success('Transcription Complete', `Transcribed ${success} book${success !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}`);
    } else {
      toast.error('Transcription Failed', `All ${failed} books failed. Check Settings > Transcription.`);
    }
    batch.end('transcribe', 1500);
  };

  return {
    handleLookupAge,
    handleLookupISBN,
    handleReadFileTags,
    handleTranscribeAudio,
  };
}
