import { useState, useCallback, useRef } from 'react';
import { callBackend, cancelCurrentBatch } from '../api';
import { BookList } from '../components/scanner/BookList';
import { MetadataPanel } from '../components/scanner/MetadataPanel';
import { ActionBar } from '../components/scanner/ActionBar';
import { ProgressBar } from '../components/scanner/ProgressBar';
import { EditMetadataModal } from '../components/EditMetadataModal';
import { BulkEditModal } from '../components/BulkEditModal';
import { BulkCoverAssignment } from '../components/BulkCoverAssignment';
import { RenamePreviewModal } from '../components/RenamePreviewModal';
import { ExportImportModal } from '../components/ExportImportModal';
import { RescanModal } from '../components/RescanModal';
import { ABSPushModal } from '../components/ABSPushModal';
import { UndoToast } from '../components/UndoToast';
import { LogPanel } from '../components/LogPanel';
import { SeriesIssueModal } from '../components/SeriesIssueModal';
import { ValidationIssueModal } from '../components/ValidationIssueModal';
import { AuthorAnalysisModal } from '../components/AuthorAnalysisModal';
import { BatchFixModal } from '../components/BatchFixModal';
import { useToast } from '../components/Toast';
import { useScan } from '../hooks/useScan';
import { useFileSelection } from '../hooks/useFileSelection';
import { useGroupSelection } from '../hooks/useGroupSelection';
import { useTagOperations } from '../hooks/useTagOperations';
import { useAbsCache } from '../hooks/useAbsCache';
import { useBatchOperations } from '../hooks/useBatchOperations';
import { useModals } from '../hooks/useModals';
import { useApp } from '../context/AppContext';
import { useMetadataHandlers } from '../hooks/useMetadataHandlers';
import { useClassifyHandlers } from '../hooks/useClassifyHandlers';
import { useEnrichmentHandlers } from '../hooks/useEnrichmentHandlers';

export function ScannerPage({ onNavigateToSettings, activeTab, navigateTo, logoSvg }) {
  const {
    config, groups, setGroups, fileStatuses, updateFileStatuses, clearFileStatuses, writeProgress,
    validationResults, validationStats, validating, runValidation, runAuthorAnalysis, authorAnalysis,
    applyBatchFixes, applyAuthorFixes, clearValidation,
    seriesAnalysis, analyzingSeries, runSeriesAnalysis, applySeriesFixes
  } = useApp();
  // Consolidated modal and batch operation state
  const modals = useModals();
  const batch = useBatchOperations();

  // Toast notifications
  const toast = useToast();

  // Undo state
  const [undoStatus, setUndoStatus] = useState(null);
  const [undoing, setUndoing] = useState(false);
  const [showUndoToast, setShowUndoToast] = useState(false);

  // Check undo status
  const checkUndoStatus = useCallback(async () => {
    try {
      const status = await callBackend('get_undo_status');
      setUndoStatus(status);
      if (status.available) {
        setShowUndoToast(true);
      }
    } catch (error) {
      console.error('Failed to check undo status:', error);
    }
  }, []);

  // Handle undo
  const handleUndo = useCallback(async () => {
    if (!undoStatus?.available || undoing) return;

    setUndoing(true);
    try {
      const result = await callBackend('undo_last_write');
      setShowUndoToast(false);
      setUndoStatus(null);

      // Refresh the scan to show restored state
      if (result.success > 0) {
        // Could trigger a rescan here if needed
      }
    } catch (error) {
      console.error('Undo failed:', error);
    } finally {
      setUndoing(false);
    }
  }, [undoStatus, undoing]);

  // Dismiss undo toast
  const dismissUndo = useCallback(async () => {
    setShowUndoToast(false);
    try {
      await callBackend('clear_undo_state');
      setUndoStatus(null);
    } catch (error) {
      console.error('Failed to clear undo state:', error);
    }
  }, []);

  const {
    scanning,
    scanProgress,
    calculateETA,
    handleScan,
    handleImport,
    handleImportFromAbs,
    handleRescanAbsImports,
    handlePipelineRescan,
    handlePushAbsImports,
    handleCleanupGenres,
    handleRescan,
    cancelScan
  } = useScan();

  const fileSelection = useFileSelection();
  const {
    selectedFiles,
    setSelectedFiles,
    allSelected,
    setAllSelected,
    lastSelectedIndex,
    setLastSelectedIndex,
    selectAllInGroup,
    clearSelection,
    selectAll,
    isFileSelected,
    isGroupSelected,
    getSelectedFileIds,
    getSelectedCount,
    getSuccessCount,
    getFilesWithChanges
  } = fileSelection;

  const {
    selectedGroup,
    setSelectedGroup,
    selectedGroupIds,
    setSelectedGroupIds,
    expandedGroups,
    setExpandedGroups,
    handleGroupClick,
    handleSelectGroup,
    handleSelectAll,
    handleSelectFiltered,
    handleClearSelection,
    toggleGroup,
  } = useGroupSelection({ groups, fileSelection });

  const {
    writing,
    pushing,
    writeSelectedTags,
    renameFiles,
    pushToAudiobookShelf
  } = useTagOperations();

  const {
    refreshing: refreshingCache,
    refreshCache,
    cacheStatus,
  } = useAbsCache();

  const handleEditMetadata = (group) => {
    modals.open('edit', { group });
  };

  const handleSaveMetadata = (newMetadata) => {
    const editGroup = modals.data.edit?.group;
    if (!editGroup) return;

    setGroups(prevGroups =>
      prevGroups.map(group => {
        if (group.id === editGroup.id) {
          const updatedFiles = (group.files || []).map(file => {
            const changes = {};

            const oldTitle = file.changes.title?.old || '';
            const oldAuthor = file.changes.author?.old || '';
            const oldNarrator = file.changes.narrator?.old || '';
            const oldGenre = file.changes.genre?.old || '';
            
            if (oldTitle !== newMetadata.title) {
              changes.title = { old: oldTitle, new: newMetadata.title };
            }
            
            if (oldAuthor !== newMetadata.author) {
              changes.author = { old: oldAuthor, new: newMetadata.author };
            }
            
            if (newMetadata.narrator) {
              const newNarratorValue = `Narrated by ${newMetadata.narrator}`;
              if (oldNarrator !== newNarratorValue) {
                changes.narrator = { old: oldNarrator, new: newNarratorValue };
              }
            }
            
            if (newMetadata.genres?.length > 0) {
              const newGenre = newMetadata.genres.join(', ');
              if (oldGenre !== newGenre) {
                changes.genre = { old: oldGenre, new: newGenre };
              }
            }
            
            if (newMetadata.series) {
              changes.series = { old: '', new: newMetadata.series };
            }
            
            if (newMetadata.sequence) {
              changes.sequence = { old: '', new: newMetadata.sequence };
            }
            
            if (newMetadata.year) {
              changes.year = { old: file.changes.year?.old || '', new: newMetadata.year };
            }
            
            if (newMetadata.publisher) {
              changes.publisher = { old: '', new: newMetadata.publisher };
            }
            
            if (newMetadata.description) {
              changes.description = { old: '', new: newMetadata.description };
            }
            
            return {
              ...file,
              changes,
              status: Object.keys(changes).length > 0 ? 'changed' : 'unchanged'
            };
          });
          
          return {
            ...group,
            metadata: newMetadata,
            files: updatedFiles,
            total_changes: updatedFiles.filter(f => Object.keys(f.changes).length > 0).length
          };
        }
        return group;
      })
    );
  };

  // Get selected groups for bulk edit
  const getSelectedGroups = () => {
    if (allSelected) return groups;
    return groups.filter(g => selectedGroupIds.has(g.id));
  };

  // Handle bulk edit save
  const handleBulkSave = (updates) => {
    if (selectedGroupIds.size === 0 && !allSelected) return;

    setGroups(prevGroups =>
      prevGroups.map(group => {
        if (!allSelected && !selectedGroupIds.has(group.id)) return group;

        // Merge updates into metadata
        const newMetadata = {
          ...group.metadata,
          ...updates,
          // Mark source as manual for bulk edited fields
          sources: {
            ...group.metadata.sources,
            ...(updates.author && { author: 'manual' }),
            ...(updates.narrator && { narrator: 'manual' }),
            ...(updates.genres && { genres: 'manual' }),
            ...(updates.publisher && { publisher: 'manual' }),
            ...(updates.language && { language: 'manual' }),
            ...(updates.year && { year: 'manual' }),
            ...(updates.series && { series: 'manual' }),
          },
        };

        // Update file changes
        const updatedFiles = (group.files || []).map(file => {
          const changes = { ...file.changes };

          if (updates.author) {
            const oldAuthor = file.changes.author?.old || '';
            if (oldAuthor !== updates.author) {
              changes.author = { old: oldAuthor, new: updates.author };
            }
          }

          if (updates.narrator) {
            const oldNarrator = file.changes.narrator?.old || '';
            const newNarratorValue = `Narrated by ${updates.narrator}`;
            if (oldNarrator !== newNarratorValue) {
              changes.narrator = { old: oldNarrator, new: newNarratorValue };
            }
          }

          if (updates.genres) {
            const oldGenre = file.changes.genre?.old || '';
            const newGenre = updates.genres.join(', ');
            if (oldGenre !== newGenre) {
              changes.genre = { old: oldGenre, new: newGenre };
            }
          }

          if (updates.series !== undefined) {
            changes.series = { old: '', new: updates.series || '' };
          }

          if (updates.sequence) {
            changes.sequence = { old: '', new: updates.sequence };
          }

          if (updates.year) {
            changes.year = { old: file.changes.year?.old || '', new: updates.year };
          }

          if (updates.publisher) {
            changes.publisher = { old: '', new: updates.publisher };
          }

          return {
            ...file,
            changes,
            status: Object.keys(changes).length > 0 ? 'changed' : 'unchanged'
          };
        });

        return {
          ...group,
          metadata: newMetadata,
          files: updatedFiles,
          total_changes: updatedFiles.filter(f => Object.keys(f.changes).length > 0).length
        };
      })
    );

  };

  // Handle import from CSV/JSON
  const handleDataImport = (updates) => {
    if (!updates || updates.length === 0) return;

    // If updates is an array of BookGroups (from JSON import)
    if (updates[0]?.files) {
      // Full JSON import - replace groups
      // For now just log - could merge or replace
      return;
    }

    // CSV import - update matched groups
    setGroups(prevGroups =>
      prevGroups.map(group => {
        const update = updates.find(u => u.group_id === group.id);
        if (!update) return group;

        const newMetadata = { ...group.metadata };
        const meta = update.metadata;

        if (meta.title) newMetadata.title = meta.title;
        if (meta.subtitle) newMetadata.subtitle = meta.subtitle;
        if (meta.author) newMetadata.author = meta.author;
        if (meta.narrator) newMetadata.narrator = meta.narrator;
        if (meta.series) newMetadata.series = meta.series;
        if (meta.sequence) newMetadata.sequence = meta.sequence;
        if (meta.genres) newMetadata.genres = meta.genres;
        if (meta.publisher) newMetadata.publisher = meta.publisher;
        if (meta.year) newMetadata.year = meta.year;
        if (meta.language) newMetadata.language = meta.language;
        if (meta.description) newMetadata.description = meta.description;
        if (meta.isbn) newMetadata.isbn = meta.isbn;
        if (meta.asin) newMetadata.asin = meta.asin;

        // Mark source as manual for imported fields
        newMetadata.sources = {
          ...newMetadata.sources,
          ...(meta.title && { title: 'manual' }),
          ...(meta.author && { author: 'manual' }),
          ...(meta.narrator && { narrator: 'manual' }),
          ...(meta.series && { series: 'manual' }),
          ...(meta.genres && { genres: 'manual' }),
          ...(meta.publisher && { publisher: 'manual' }),
          ...(meta.year && { year: 'manual' }),
        };

        // Update file changes
        const updatedFiles = (group.files || []).map(file => {
          const changes = { ...file.changes };

          if (meta.title && meta.title !== group.metadata.title) {
            changes.title = { old: group.metadata.title, new: meta.title };
          }
          if (meta.author && meta.author !== group.metadata.author) {
            changes.author = { old: group.metadata.author, new: meta.author };
          }

          return {
            ...file,
            changes,
            status: Object.keys(changes).length > 0 ? 'changed' : 'unchanged'
          };
        });

        return {
          ...group,
          metadata: newMetadata,
          files: updatedFiles,
          total_changes: updatedFiles.filter(f => Object.keys(f.changes).length > 0).length
        };
      })
    );

  };

  // ✅ SIMPLIFIED - No popups, just write with toast feedback
  const handleWriteClick = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0 && !allSelected) {
      toast.warning('No Selection', 'Select files before writing.');
      return;
    }

    const filesWithChanges = getFilesWithChanges(groups);
    if (filesWithChanges.length === 0) {
      toast.info('No Changes', 'Selected books have no pending changes to write.');
      return;
    }

    try {
      const actualSelectedFiles = getSelectedFileIds(groups);
      const result = await writeSelectedTags(actualSelectedFiles, false); // false = no backup for speed

      if (result.success > 0) {
        toast.success('Write Complete', `Successfully wrote ${result.success} file${result.success > 1 ? 's' : ''}.`);
        handleClearSelection();
        // Check undo status after successful write
        await checkUndoStatus();
      }
      if (result.failed > 0) {
        toast.error('Write Errors', `Failed to write ${result.failed} file${result.failed > 1 ? 's' : ''}. Check console for details.`);
      }
    } catch (error) {
      console.error('Write failed:', error);
      toast.error('Write Failed', error.toString());
    }
  };

  // ✅ SIMPLIFIED - No popup
  const handleRenameClick = () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0 && !allSelected) return;
    modals.open('rename');
  };

  // ✅ Rescan with configurable mode and optional selective fields
  // @param {string} scanMode - 'normal', 'refresh_metadata', 'force_fresh', 'selective_refresh', 'super_scanner'
  // @param {Array} selectiveFields - Optional array of field names for selective refresh
  // @param {Object} options - Optional options like { enableTranscription: bool }
  const handleRescanClick = async (scanMode = 'force_fresh', selectiveFields = null, options = {}) => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    if (selectedGroups.length === 0) return;

    // Check if these are ABS imports (no local files)
    const absImports = selectedGroups.filter(g => (g.files?.length || 0) === 0);
    const localFiles = selectedGroups.filter(g => (g.files?.length || 0) > 0);

    try {
      const modeLabel = selectiveFields
        ? `selective refresh (${selectiveFields.join(', ')})`
        : scanMode === 'super_scanner'
          ? 'deep scan'
          : scanMode === 'normal'
            ? 'smart scan'
            : 'clean scan';

      // Handle ABS imports (no local files)
      if (absImports.length > 0) {
        // For ABS imports, use force_fresh mode which searches APIs
        // Pass selectiveFields to only update specific fields if custom rescan
        const result = await handleRescanAbsImports(absImports, 'force_fresh', false, selectiveFields);
      }

      // Handle local files (if any mixed in)
      if (localFiles.length > 0) {
        const transcriptionLabel = options.enableTranscription ? ' + audio verification' : '';
        const actualSelectedFiles = getSelectedFileIds(groups);
        const result = await handleRescan(actualSelectedFiles, groups, scanMode, selectiveFields, options);
      }

      handleClearSelection();
      clearFileStatuses();
    } catch (error) {
      console.error('Rescan failed:', error);
    }
  };

  // Bridge getters: read from batch operations hook (setters use batch.start/update/end)
  const cleaningGenres = batch.isActive('genres');
  const genreProgress = batch.getProgress('genres');
  const assigningTags = batch.isActive('tags');
  const tagProgress = batch.getProgress('tags');
  const fixingDescriptions = batch.isActive('descriptions');
  const descProgress = batch.getProgress('descriptions');
  const fixingTitles = batch.isActive('titles');
  const titleProgress = batch.getProgress('titles');
  const fixingSubtitles = batch.isActive('subtitles');
  const subtitleProgress = batch.getProgress('subtitles');
  const fixingAuthors = batch.isActive('authors');
  const authorProgress = batch.getProgress('authors');
  const fixingYears = batch.isActive('years');
  const yearProgress = batch.getProgress('years');
  const fixingSeries = batch.isActive('series');
  const seriesProgress = batch.getProgress('series');
  const lookingUpAge = batch.isActive('age');
  const ageProgress = batch.getProgress('age');
  const lookingUpISBN = batch.isActive('isbn');
  const isbnProgress = batch.getProgress('isbn');
  const runningAll = batch.isActive('enrichment');
  const runAllProgress = batch.getProgress('enrichment');
  const generatingDna = batch.isActive('dna');
  const dnaProgress = batch.getProgress('dna');
  const resolvingMetadata = batch.isActive('metadata');
  const metadataProgress = batch.getProgress('metadata');
  const processingDescriptions = batch.isActive('descriptionProcessing');
  const descriptionProgress = batch.getProgress('descriptionProcessing');
  const readingFileTags = batch.isActive('fileTags');
  const transcribing = batch.isActive('transcribe');
  const classifying = batch.isActive('classify');
  const classifyProgress = batch.getProgress('classify');
  const forceFresh = batch.forceFresh;
  const dnaEnabled = batch.dnaEnabled;

  // Ref to hold pre-fetched data from gather phase (used by handleRunAll)
  const gatheredDataRef = useRef(null);

  // Domain-specific operation hooks
  const { handleFixTitles, handleFixSubtitles, handleFixAuthors, handleFixYears, handleFixSeries, handleMetadataResolution, handleDescriptionProcessing } = useMetadataHandlers({ groups, setGroups, selectedGroupIds, allSelected, batch, config, toast, getSelectedCount, gatheredDataRef });
  const { handleGenreCleanup, handleAssignTagsGpt, handleGenerateDna, handleClassifyAll, handleFixDescriptionsGpt } = useClassifyHandlers({ groups, setGroups, selectedGroupIds, allSelected, batch, config, toast, getSelectedCount, handleCleanupGenres });
  const { handleLookupAge, handleLookupISBN, handleReadFileTags, handleTranscribeAudio } = useEnrichmentHandlers({ groups, setGroups, selectedGroupIds, allSelected, batch, config, toast, getSelectedCount, gatheredDataRef });

  // ✅ RUN ALL - Sequential enrichment: title -> description -> tags -> age -> isbn -> dna
  const handleRunAll = async () => {
    const selectedCount = getSelectedCount(groups, selectedGroupIds);
    if (selectedCount === 0) return;

    // Phase 1: Gather all external API data upfront
    const totalSteps = 6; // gather + 5 enrichment steps
    batch.start('enrichment', {
      total: totalSteps,
      currentBook: 'Step 1/6: Gathering external data (ABS, Goodreads, Open Library, Google Books)...',
    });

    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));

    try {
      const gatherBooks = selectedGroups.map(g => ({
        id: g.id,
        title: g.metadata?.title || g.group_name || '',
        author: g.metadata?.author || '',
      }));

      const gatherResult = await callBackend('gather_external_data', { books: gatherBooks, config });

      // Store gathered data in a Map keyed by book ID
      const dataMap = new Map();
      for (const item of (gatherResult.results || [])) {
        dataMap.set(item.id, item);
      }
      gatheredDataRef.current = dataMap;
    } catch (error) {
      console.error('Phase 1 (gather) failed:', error);
      gatheredDataRef.current = null;
      // Continue anyway — individual steps will fall back to their own API calls
    }

    batch.update('enrichment', {
      current: 1,
      success: 1,
      currentBook: 'Finished gathering external data',
    });

    await new Promise(resolve => setTimeout(resolve, 300));

    // Phase 2: Run enrichment steps sequentially (GPT-heavy, using pre-fetched data)
    const steps = [
      { name: 'Metadata Resolution (title, subtitle, author, series)', fn: handleMetadataResolution },
      { name: 'ISBN/ASIN Lookup', fn: handleLookupISBN },
      { name: 'Publication Year', fn: handleFixYears },
      { name: 'Classification & Tagging (genres, tags, age, DNA)', fn: () => handleClassifyAll(false) },
      { name: 'Description Processing (validate, clean, generate)', fn: handleDescriptionProcessing },
    ];

    let successCount = 1; // gather phase counted as 1
    let failedCount = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const stepNum = i + 2; // offset by 1 for gather phase
      batch.update('enrichment', {
        current: stepNum - 1,
        currentBook: `Step ${stepNum}/${totalSteps}: ${step.name}`,
      });

      try {
        await step.fn();
        successCount++;
      } catch (error) {
        console.error(`${step.name} failed:`, error);
        failedCount++;
      }

      batch.update('enrichment', {
        current: stepNum,
        success: successCount,
        failed: failedCount,
        currentBook: stepNum < totalSteps ? `Finished ${step.name}` : 'Complete!',
      });

      if (i + 1 < steps.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Clear gathered data
    gatheredDataRef.current = null;

    batch.end('enrichment', 2000);
  };

  // ✅ Fix a single issue on a single book
  const handleFixSingleIssue = useCallback((groupId, field, suggestedValue) => {
    setGroups(prevGroups => prevGroups.map(group => {
      if (group.id !== groupId) return group;

      const newMetadata = { ...group.metadata };

      // Apply the fix based on field
      switch (field) {
        case 'author':
          newMetadata.author = suggestedValue;
          // Also update authors array to keep UI in sync
          newMetadata.authors = [suggestedValue, ...(newMetadata.authors || []).slice(1)];
          break;
        case 'title':
          newMetadata.title = suggestedValue;
          break;
        case 'series':
          newMetadata.series = suggestedValue;
          // Also update all_series array to keep UI in sync
          if (newMetadata.all_series?.length > 0) {
            newMetadata.all_series = [{ ...newMetadata.all_series[0], name: suggestedValue }, ...newMetadata.all_series.slice(1)];
          } else {
            newMetadata.all_series = [{ name: suggestedValue, sequence: newMetadata.sequence }];
          }
          break;
        case 'sequence':
          newMetadata.sequence = suggestedValue;
          // Also update all_series array to keep UI in sync
          if (newMetadata.all_series?.length > 0) {
            newMetadata.all_series = [{ ...newMetadata.all_series[0], sequence: suggestedValue }, ...newMetadata.all_series.slice(1)];
          }
          break;
        case 'narrator':
          newMetadata.narrator = suggestedValue;
          // Also update narrators array to keep UI in sync
          newMetadata.narrators = [suggestedValue, ...(newMetadata.narrators || []).slice(1)];
          break;
        case 'description':
          newMetadata.description = suggestedValue;
          break;
        case 'genres':
          if (typeof suggestedValue === 'string') {
            newMetadata.genres = suggestedValue.split(',').map(g => g.trim()).filter(Boolean);
          } else if (Array.isArray(suggestedValue)) {
            newMetadata.genres = suggestedValue;
          }
          break;
        default:
          if (field in newMetadata) {
            newMetadata[field] = suggestedValue;
          }
      }

      return {
        ...group,
        metadata: newMetadata,
        total_changes: (group.total_changes || 0) + 1,
      };
    }));

  }, [setGroups]);

  // ✅ Run author analysis and show review modal when complete
  const handleAuthorAnalysis = useCallback(async () => {
    await runAuthorAnalysis(groups);
    // Show modal after analysis completes
    modals.open('author');
  }, [groups, runAuthorAnalysis]);

  // ✅ Apply selected author normalizations from the review modal
  const handleApplyAuthorFixes = useCallback((fixes) => {
    if (!fixes || fixes.length === 0) return;

    setGroups(prevGroups => {
      const fixesByBook = fixes.reduce((map, fix) => {
        map[fix.bookId] = fix.canonicalAuthor;
        return map;
      }, {});

      return prevGroups.map(group => {
        const canonicalAuthor = fixesByBook[group.id];
        if (!canonicalAuthor) return group;

        return {
          ...group,
          metadata: {
            ...group.metadata,
            author: canonicalAuthor,
            authors: [canonicalAuthor, ...(group.metadata.authors || []).slice(1)],
            sources: {
              ...group.metadata.sources,
              author: 'normalized',
            },
          },
          total_changes: (group.total_changes || 0) + 1,
        };
      });
    });

    clearValidation();
  }, [setGroups, clearValidation]);

  // ✅ Run validation scan and show review modal when complete
  // Works with selection - validates only selected books, or all if none selected
  const handleScanErrors = useCallback(async () => {
    const groupsToValidate = selectedGroupIds.size > 0 || allSelected
      ? (allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id)))
      : groups; // Fall back to all groups if no selection
    await runValidation(groupsToValidate);
    // Show modal after validation completes
    modals.open('validation');
  }, [groups, runValidation, selectedGroupIds, allSelected]);

  // ✅ Apply selected validation fixes from the review modal
  const handleApplyValidationFixes = useCallback((fixes) => {
    if (!fixes || fixes.length === 0) return;

    setGroups(prevGroups => {
      const fixesByBook = fixes.reduce((map, fix) => {
        if (!map[fix.bookId]) map[fix.bookId] = [];
        map[fix.bookId].push(fix);
        return map;
      }, {});

      return prevGroups.map(group => {
        const bookFixes = fixesByBook[group.id];
        if (!bookFixes) return group;

        const newMetadata = { ...group.metadata };

        for (const fix of bookFixes) {
          switch (fix.field) {
            case 'author':
              newMetadata.author = fix.suggestedValue;
              newMetadata.authors = [fix.suggestedValue, ...(newMetadata.authors || []).slice(1)];
              break;
            case 'title':
              newMetadata.title = fix.suggestedValue;
              break;
            case 'series':
              newMetadata.series = fix.suggestedValue;
              if (newMetadata.all_series?.length > 0) {
                newMetadata.all_series = [{ ...newMetadata.all_series[0], name: fix.suggestedValue }, ...newMetadata.all_series.slice(1)];
              } else {
                newMetadata.all_series = [{ name: fix.suggestedValue, sequence: newMetadata.sequence }];
              }
              break;
            case 'sequence':
              newMetadata.sequence = fix.suggestedValue;
              if (newMetadata.all_series?.length > 0) {
                newMetadata.all_series = [{ ...newMetadata.all_series[0], sequence: fix.suggestedValue }, ...newMetadata.all_series.slice(1)];
              }
              break;
            case 'narrator':
              newMetadata.narrator = fix.suggestedValue;
              newMetadata.narrators = [fix.suggestedValue, ...(newMetadata.narrators || []).slice(1)];
              break;
            case 'description':
              newMetadata.description = fix.suggestedValue;
              break;
            case 'genres':
              if (typeof fix.suggestedValue === 'string') {
                newMetadata.genres = fix.suggestedValue.split(',').map(g => g.trim()).filter(Boolean);
              } else if (Array.isArray(fix.suggestedValue)) {
                newMetadata.genres = fix.suggestedValue;
              }
              break;
            default:
              if (fix.field in newMetadata) {
                newMetadata[fix.field] = fix.suggestedValue;
              }
          }
        }

        return {
          ...group,
          metadata: newMetadata,
          total_changes: (group.total_changes || 0) + bookFixes.length,
        };
      });
    });

    clearValidation();
  }, [setGroups, clearValidation]);

  // ✅ Run series analysis and show review modal when complete
  // Works with selection - analyzes only selected books, or all if none selected
  const handleSeriesAnalysis = useCallback(async () => {
    const groupsToAnalyze = selectedGroupIds.size > 0 || allSelected
      ? (allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id)))
      : groups; // Fall back to all groups if no selection
    await runSeriesAnalysis(groupsToAnalyze);
    // Show modal after analysis completes
    modals.open('series');
  }, [groups, runSeriesAnalysis, selectedGroupIds, allSelected]);

  // ✅ Apply selected series fixes from the review modal
  const handleApplySeriesFixes = useCallback(async (fixes) => {
    if (!fixes || fixes.length === 0) return;

    try {
      const updatedGroups = await applySeriesFixes(groups, fixes);
      setGroups(updatedGroups.updatedGroups);
      clearValidation();
    } catch (error) {
      console.error('Failed to apply series fixes:', error);
    }
  }, [groups, setGroups, applySeriesFixes, clearValidation]);

  // ✅ Cancel any running scan
  const handleCancelScan = useCallback(async () => {
    // Cancel scan hook's scan
    cancelScan();
    // Also cancel series scan in backend
    try {
      await callBackend('cancel_series_scan');
    } catch (e) {
      // Ignore if not running
    }
  }, [cancelScan]);

  // ✅ Count pending batch fixes and show confirmation modal
  const handleBatchFix = useCallback(() => {
    // Count validation fixes by issue type
    let validationFixCount = 0;
    const byType = {};
    let hasAuthorIssuesInValidation = false;
    let hasSeriesIssuesInValidation = false;

    if (Object.keys(validationResults).length > 0) {
      for (const validation of Object.values(validationResults)) {
        if (validation?.issues) {
          for (const issue of validation.issues) {
            // Only count fixable issues (with suggested_value)
            if (issue.suggested_value) {
              validationFixCount++;
              byType[issue.issue_type] = (byType[issue.issue_type] || 0) + 1;
            }
            // Track hints for author/series
            if (issue.issue_type === 'AuthorNeedsNormalization') hasAuthorIssuesInValidation = true;
            if (issue.issue_type === 'SeriesContainsNumber' ||
                issue.issue_type === 'TitleMatchesSeries' ||
                issue.issue_type === 'MissingSequence') hasSeriesIssuesInValidation = true;
          }
        }
      }
    }

    // Count author fixes
    let authorFixCount = 0;
    if (authorAnalysis?.needs_normalization) {
      for (const candidate of authorAnalysis.needs_normalization) {
        if (candidate.canonical) {
          const authorLower = candidate.name.toLowerCase();
          authorFixCount += groups.filter(g =>
            g.metadata?.author?.toLowerCase() === authorLower &&
            g.metadata?.author !== candidate.canonical
          ).length;
        }
      }
    }

    // Count series fixes
    const seriesFixCount = seriesAnalysis?.all_fixes?.length || 0;

    const totalFixes = validationFixCount + authorFixCount + seriesFixCount;

    if (totalFixes === 0) {
      toast.info('No Fixes Available', 'No suggested fixes found to apply.');
      return;
    }

    // Set validation breakdown by type
    modals.setBatchFixData({ validationByType: byType });

    // Pre-select all validation types
    const selectedTypes = {};
    Object.keys(byType).forEach(type => {
      selectedTypes[type] = true;
    });
    modals.setBatchFixData({ selectedValidationTypes: selectedTypes });

    modals.setBatchFixData({
      pending: {
        validation: validationFixCount,
        author: authorFixCount,
        series: seriesFixCount,
        hasAuthorIssuesInValidation,
        hasSeriesIssuesInValidation
      }
    });
    // Pre-select fix types that have fixes available
    modals.setBatchFixData({
      selectedTypes: {
        validation: validationFixCount > 0,
        author: authorFixCount > 0,
        series: seriesFixCount > 0
      }
    });
    modals.open('batchFix');
  }, [groups, validationResults, authorAnalysis, seriesAnalysis, toast]);

  // ✅ Actually apply batch fixes after confirmation (only selected types)
  const confirmBatchFix = useCallback(async () => {
    let currentGroups = groups;
    let totalFixes = 0;
    const appliedTypes = [];

    const bfData = modals.data.batchFix;

    // Apply validation fixes if selected (filtered by selected validation sub-types)
    if (bfData.selectedTypes.validation && bfData.pending.validation > 0) {
      // Check if any validation sub-types are selected
      const hasSubTypeSelection = Object.keys(bfData.validationByType).length > 0;
      const anySubTypeSelected = hasSubTypeSelection
        ? Object.values(bfData.selectedValidationTypes).some(v => v)
        : true;

      if (anySubTypeSelected) {
        // Pass selectedValidationTypes to filter which issue types to apply
        const validationResult = applyBatchFixes(
          currentGroups,
          hasSubTypeSelection ? bfData.selectedValidationTypes : null
        );
        currentGroups = validationResult.updatedGroups;
        totalFixes += validationResult.fixCount;
        if (validationResult.fixCount > 0) appliedTypes.push('validation');
      }
    }

    // Apply author normalizations if selected
    if (bfData.selectedTypes.author && bfData.pending.author > 0) {
      const authorResult = applyAuthorFixes(currentGroups);
      currentGroups = authorResult.updatedGroups;
      totalFixes += authorResult.fixCount;
      if (authorResult.fixCount > 0) appliedTypes.push('author');
    }

    // Apply series fixes if selected (async)
    if (bfData.selectedTypes.series && seriesAnalysis?.all_fixes?.length > 0) {
      const seriesResult = await applySeriesFixes(currentGroups, seriesAnalysis.all_fixes);
      currentGroups = seriesResult.updatedGroups;
      totalFixes += seriesResult.fixCount;
      if (seriesResult.fixCount > 0) appliedTypes.push('series');
    }

    if (totalFixes > 0) {
      setGroups(currentGroups);
      // Clear validation after applying fixes - user can re-scan to verify
      clearValidation();
      toast.success('Fixes Applied', `Applied ${totalFixes} ${appliedTypes.join(', ')} fix${totalFixes > 1 ? 'es' : ''}.`);
    } else {
      toast.info('No Changes', 'No fixes were applied.');
    }
  }, [groups, setGroups, applyBatchFixes, applyAuthorFixes, applySeriesFixes, seriesAnalysis, clearValidation, toast, modals.data.batchFix]);

  // Toggle fix type selection
  const toggleFixType = useCallback((type) => {
    modals.toggleFixType(type);
  }, [modals]);

  // Toggle validation sub-type selection
  const toggleValidationType = useCallback((issueType) => {
    modals.toggleValidationType(issueType);
  }, [modals]);

  // ✅ Pipeline rescan for ABS imports (new architecture)
  const handlePipelineClick = async () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    // Only process ABS imports (groups with no local files)
    const absImports = selectedGroups.filter(g => (g.files?.length || 0) === 0);

    if (absImports.length === 0) {
      return;
    }

    try {
      const result = await handlePipelineRescan(absImports);
      handleClearSelection();
    } catch (error) {
      console.error('Pipeline rescan failed:', error);
    }
  };

  // ✅ Check if selected books are ABS-imported (no local files)
  const getSelectedAbsImports = () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    return selectedGroups.filter(g => (g.files?.length || 0) === 0);
  };

  // ✅ Clean ALL genres for all loaded books (no selection needed)
  const handleCleanupAllGenres = async () => {
    if (groups.length === 0) return;

    try {
      // Check if these are ABS imports (no files)
      const absImports = groups.filter(g => (g.files?.length || 0) === 0);

      if (absImports.length > 0) {
        // Use ABS rescan for genre cleanup
        const result = await handleRescanAbsImports(absImports, 'genres_only');
      } else {
        // Use regular genre cleanup
        const result = await handleCleanupGenres(groups);
      }
    } catch (error) {
      console.error('Genre cleanup failed:', error);
    }
  };

  // ✅ Rescan ABS imports with fresh API data
  // options: { enrichWithCustomProviders: boolean }
  const handleAbsRescan = async (mode = 'force_fresh', options = {}) => {
    const absImports = getSelectedAbsImports();
    if (absImports.length === 0) return;

    try {
      const modeLabel = mode === 'genres_only' ? 'genre cleanup' : 'fresh scan';
      const enrichLabel = options.enrichWithCustomProviders ? ' + Goodreads/Hardcover' : '';
      const result = await handleRescanAbsImports(absImports, mode, false, null, options.enrichWithCustomProviders || false);
      handleClearSelection();
    } catch (error) {
      console.error('ABS rescan failed:', error);
    }
  };

  // ✅ Show push confirmation modal before pushing
  const handlePushClick = () => {
    const selectedGroups = allSelected ? groups : groups.filter(g => selectedGroupIds.has(g.id));
    if (selectedGroups.length === 0) {
      return;
    }
    modals.open('push', { groups: selectedGroups });
  };

  // ✅ Actually push after confirmation
  const handleConfirmPush = async () => {
    const pushGroups = modals.data.push?.groups || [];
    if (pushGroups.length === 0) return;

    // Check if these are ABS imports (no local files)
    const absImports = pushGroups.filter(g => (g.files?.length || 0) === 0);
    const localFiles = pushGroups.filter(g => (g.files?.length || 0) > 0);

    try {
      // Handle ABS imports - use direct ID-based push
      if (absImports.length > 0) {
        const result = await handlePushAbsImports(absImports);
      }

      // Handle local files - use path-based push
      if (localFiles.length > 0) {
        const actualSelectedFiles = getSelectedFileIds(groups);

        const result = await pushToAudiobookShelf(
          actualSelectedFiles,
          (progress) => {
          }
        );


        if (result.unmatched?.length > 0) {
        }
        if (result.failed?.length > 0) {
        }
      }
    } catch (error) {
      console.error('Push failed:', error);
    } finally {
      modals.close('push');
    }
  };

  return (
    <div className="h-full flex flex-col relative">
      {/* Action bars at the top */}
      <ActionBar
        logoSvg={logoSvg}
        activeTab={activeTab}
        navigateTo={navigateTo}
        selectedFiles={selectedFiles}
        allSelected={allSelected}
        groups={groups}
        fileStatuses={fileStatuses}
        selectedGroupCount={selectedGroupIds.size}
        totalBookCount={groups.length}
        onScan={handleScan}
        onRescan={handleRescanClick}
        onPipelineRescan={handlePipelineClick}
        onWrite={handleWriteClick}
        onRename={handleRenameClick}
        onPush={handlePushClick}
        onPull={handleImportFromAbs}
        onRefreshCache={refreshCache}
        onBulkEdit={() => modals.open('bulkEdit')}
        onBulkCover={() => modals.open('bulkCover')}
        onOpenRescanModal={() => modals.open('rescan')}
        onCleanupGenres={handleGenreCleanup}
        onAssignTagsGpt={handleAssignTagsGpt}
        onFixDescriptions={handleFixDescriptionsGpt}
        onFixTitles={handleFixTitles}
        onFixSubtitles={handleFixSubtitles}
        onFixAuthors={handleFixAuthors}
        onFixYears={handleFixYears}
        onFixSeries={handleFixSeries}
        onLookupAge={handleLookupAge}
        onLookupISBN={handleLookupISBN}
        onRunAll={handleRunAll}
        onGenerateDna={handleGenerateDna}
        onReadFileTags={handleReadFileTags}
        onTranscribeAudio={handleTranscribeAudio}
        readingFileTags={readingFileTags}
        transcribing={transcribing}
        onClassifyAll={handleClassifyAll}
        classifying={classifying}
        onMetadataResolution={handleMetadataResolution}
        resolvingMetadata={resolvingMetadata}
        onDescriptionProcessing={handleDescriptionProcessing}
        processingDescriptions={processingDescriptions}
        onClearSelection={handleClearSelection}
        onSelectAll={handleSelectAll}
        onScanErrors={handleScanErrors}
        onAuthorMatch={handleAuthorAnalysis}
        onSeriesAnalysis={handleSeriesAnalysis}
        onBatchFix={handleBatchFix}
        onNavigateToSettings={onNavigateToSettings}
        validationStats={validationStats}
        validating={validating}
        authorAnalysis={authorAnalysis}
        seriesAnalysis={seriesAnalysis}
        analyzingSeries={analyzingSeries}
        writing={writing}
        pushing={pushing}
        scanning={scanning}
        cleaningGenres={cleaningGenres}
        assigningTags={assigningTags}
        fixingDescriptions={fixingDescriptions}
        fixingTitles={fixingTitles}
        fixingSubtitles={fixingSubtitles}
        fixingAuthors={fixingAuthors}
        fixingYears={fixingYears}
        fixingSeries={fixingSeries}
        lookingUpAge={lookingUpAge}
        lookingUpISBN={lookingUpISBN}
        runningAll={runningAll}
        generatingDna={generatingDna}
        refreshingCache={refreshingCache}
        hasAbsConnection={!!(config?.abs_base_url && config?.abs_api_token)}
        hasOpenAiKey={!!(config?.openai_api_key || config?.anthropic_api_key || config?.use_local_ai || config?.use_claude_cli)}
        useLocalAI={!!(config?.use_local_ai && config?.ollama_model)}
        aiModel={config?.ai_model}
        forceFresh={forceFresh}
        onToggleForceFresh={() => batch.toggleForceFresh()}
        dnaEnabled={dnaEnabled}
        onToggleDna={() => batch.toggleDna()}
      />

      {/* Main content area with book list and metadata panel */}
      <div className="flex-1 flex overflow-hidden bg-neutral-950">
        <BookList
          groups={groups}
          selectedFiles={selectedFiles}
          allSelected={allSelected}
          selectedGroup={selectedGroup}
          selectedGroupIds={selectedGroupIds}
          expandedGroups={expandedGroups}
          fileStatuses={fileStatuses}
          onGroupClick={setSelectedGroup}
          onToggleGroup={toggleGroup}
          onSelectGroup={handleSelectGroup}
          onSelectFile={handleGroupClick}
          onScan={handleScan}
          onImport={handleImport}
          onImportFromAbs={handleImportFromAbs}
          onCleanupAllGenres={handleCleanupAllGenres}
          scanning={scanning}
          onSelectAll={handleSelectAll}
          onSelectFiltered={handleSelectFiltered}
          onClearSelection={handleClearSelection}
          onExport={() => modals.open('export')}
          validationResults={validationResults}
          hasAbsConnection={!!(config?.abs_base_url && config?.abs_api_token)}
          onNavigateToSettings={onNavigateToSettings}
        />

        <MetadataPanel
          group={selectedGroup}
          onEdit={handleEditMetadata}
          onInlineEdit={(groupId, field, value) => {
            setGroups(prev => prev.map(g => {
              if (g.id !== groupId) return g;
              return { ...g, metadata: { ...g.metadata, [field]: value } };
            }));
          }}
          validationData={selectedGroup ? validationResults[selectedGroup.id] : null}
          onFixIssue={handleFixSingleIssue}
        />
      </div>

      {/* Progress bars */}
      {scanning && (
        <ProgressBar
          key={scanProgress.startTime} 
          type="scan"
          progress={scanProgress}
          onCancel={cancelScan}
          calculateETA={calculateETA}
        />
      )}

      {writing && writeProgress.total > 0 && (
        <ProgressBar
          type="write"
          progress={writeProgress}
        />
      )}

      {assigningTags && tagProgress.total > 0 && (
        <ProgressBar
          type="tags"
          progress={tagProgress}
        />
      )}

      {fixingDescriptions && descProgress.total > 0 && (
        <ProgressBar
          type="descriptions"
          progress={descProgress}
        />
      )}

      {fixingTitles && titleProgress.total > 0 && (
        <ProgressBar
          type="titles"
          progress={titleProgress}
        />
      )}

      {fixingSubtitles && subtitleProgress.total > 0 && (
        <ProgressBar
          type="subtitles"
          progress={subtitleProgress}
        />
      )}

      {fixingAuthors && authorProgress.total > 0 && (
        <ProgressBar
          type="authors"
          progress={authorProgress}
        />
      )}

      {fixingYears && yearProgress.total > 0 && (
        <ProgressBar
          type="years"
          progress={yearProgress}
        />
      )}

      {fixingSeries && seriesProgress.total > 0 && (
        <ProgressBar
          type="series"
          progress={seriesProgress}
        />
      )}

      {lookingUpAge && ageProgress.total > 0 && (
        <ProgressBar
          type="age"
          progress={ageProgress}
        />
      )}

      {lookingUpISBN && isbnProgress.total > 0 && (
        <ProgressBar
          type="isbn"
          progress={isbnProgress}
        />
      )}

      {runningAll && runAllProgress.total > 0 && (
        <ProgressBar
          type="enrichment"
          progress={runAllProgress}
        />
      )}

      {generatingDna && dnaProgress.total > 0 && (
        <ProgressBar
          type="dna"
          progress={dnaProgress}
          onCancel={() => {
            cancelCurrentBatch();
            batch.update('dna', { currentBook: 'Cancelling after current book...' });
          }}
        />
      )}

      {cleaningGenres && genreProgress.total > 0 && (
        <ProgressBar
          type="genres"
          progress={genreProgress}
          onCancel={() => {
            cancelCurrentBatch();
            batch.update('genres', { currentBook: 'Cancelling after current book...' });
          }}
        />
      )}

      {resolvingMetadata && metadataProgress.total > 0 && (
        <ProgressBar
          type="metadata"
          progress={metadataProgress}
          onCancel={() => {
            cancelCurrentBatch();
            batch.update('metadata', { currentBook: 'Cancelling after current book...' });
          }}
        />
      )}

      {classifying && classifyProgress.total > 0 && (
        <ProgressBar
          type="classify"
          progress={classifyProgress}
          onCancel={() => {
            cancelCurrentBatch();
            batch.update('classify', { currentBook: 'Cancelling after current book...' });
          }}
        />
      )}

      {processingDescriptions && descriptionProgress.total > 0 && (
        <ProgressBar
          type="descriptionProcessing"
          progress={descriptionProgress}
          onCancel={() => {
            cancelCurrentBatch();
            batch.update('descriptionProcessing', { currentBook: 'Cancelling after current book...' });
          }}
        />
      )}

      {/* Modals */}
      {modals.isOpen('edit') && modals.data.edit?.group && (
        <EditMetadataModal
          isOpen={modals.isOpen('edit')}
          onClose={() => modals.close('edit')}
          onSave={handleSaveMetadata}
          metadata={modals.data.edit.group.metadata}
          groupName={modals.data.edit.group.group_name}
          folderPath={modals.data.edit.group.files?.[0]?.path?.split('/').slice(0, -1).join('/') || modals.data.edit.group.metadata?.source_path || ''}
        />
      )}

      {modals.isOpen('bulkEdit') && (selectedGroupIds.size > 0 || allSelected) && (
        <BulkEditModal
          isOpen={modals.isOpen('bulkEdit')}
          onClose={() => modals.close('bulkEdit')}
          onSave={handleBulkSave}
          selectedGroups={getSelectedGroups()}
        />
      )}

      {modals.isOpen('export') && (
        <ExportImportModal
          isOpen={modals.isOpen('export')}
          onClose={() => modals.close('export')}
          groups={groups}
          onImport={handleDataImport}
        />
      )}

      {modals.isOpen('rename') && (
        <RenamePreviewModal
          selectedFiles={(() => {
            const fileIds = getSelectedFileIds(groups);
            return Array.from(fileIds).map(id => {
              for (const group of groups) {
                const file = group.files.find(f => f.id === id);
                if (file) return file.path;
              }
              return null;
            }).filter(Boolean);
          })()}
          metadata={selectedGroup?.metadata}
          onConfirm={async () => {
            try {
              const actualSelectedFiles = getSelectedFileIds(groups);
              await renameFiles(actualSelectedFiles);
              modals.close('rename');
              await handleScan();
            } catch (error) {
              console.error('Rename failed:', error);
            }
          }}
          onCancel={() => modals.close('rename')}
        />
      )}

      {modals.isOpen('rescan') && (
        <RescanModal
          isOpen={modals.isOpen('rescan')}
          onClose={() => modals.close('rescan')}
          onRescan={handleRescanClick}
          selectedCount={allSelected ? groups.reduce((sum, g) => sum + (g.files?.length || 0), 0) : selectedFiles.size}
          scanning={scanning}
        />
      )}

      {/* ABS Push Confirmation Modal */}
      <ABSPushModal
        isOpen={modals.isOpen('push')}
        onClose={() => modals.close('push')}
        onConfirm={handleConfirmPush}
        groups={modals.data.push?.groups || []}
        pushing={pushing}
      />

      {/* Bulk Cover Assignment Modal */}
      {modals.isOpen('bulkCover') && (selectedGroupIds.size > 0 || allSelected) && (
        <BulkCoverAssignment
          isOpen={modals.isOpen('bulkCover')}
          onClose={() => modals.close('bulkCover')}
          selectedGroups={getSelectedGroups()}
          onCoversAssigned={(count) => {
            // Trigger refresh of cover cache
            setGroups([...groups]);
          }}
        />
      )}

      {/* Series Issue Review Modal */}
      {modals.isOpen('series') && seriesAnalysis && (
        <SeriesIssueModal
          isOpen={modals.isOpen('series')}
          onClose={() => modals.close('series')}
          seriesAnalysis={seriesAnalysis}
          onApplyFixes={handleApplySeriesFixes}
          groups={groups}
        />
      )}

      {/* Validation Issue Review Modal */}
      {modals.isOpen('validation') && (
        <ValidationIssueModal
          isOpen={modals.isOpen('validation')}
          onClose={() => modals.close('validation')}
          validationResults={validationResults}
          selectedBooks={selectedFiles}
          groups={groups}
          onApplyFixes={handleApplyValidationFixes}
        />
      )}

      {/* Author Analysis Modal */}
      {modals.isOpen('author') && authorAnalysis && (
        <AuthorAnalysisModal
          isOpen={modals.isOpen('author')}
          onClose={() => modals.close('author')}
          authorAnalysis={authorAnalysis}
          groups={groups}
          onApplyFixes={handleApplyAuthorFixes}
        />
      )}

      {/* Batch Fix Selection Modal */}
      <BatchFixModal
        isOpen={modals.isOpen('batchFix')}
        onClose={() => modals.close('batchFix')}
        onConfirm={confirmBatchFix}
        pendingFixes={modals.data.batchFix.pending}
        selectedTypes={modals.data.batchFix.selectedTypes}
        onToggleType={toggleFixType}
        validationByType={modals.data.batchFix.validationByType}
        selectedValidationTypes={modals.data.batchFix.selectedValidationTypes}
        onToggleValidationType={toggleValidationType}
        hasAuthorIssuesInValidation={modals.data.batchFix.pending.hasAuthorIssuesInValidation}
        hasSeriesIssuesInValidation={modals.data.batchFix.pending.hasSeriesIssuesInValidation}
      />

      {/* Undo Toast */}
      {showUndoToast && undoStatus?.available && (
        <UndoToast
          booksCount={undoStatus.books_count}
          ageSeconds={undoStatus.age_seconds}
          onUndo={handleUndo}
          onDismiss={dismissUndo}
          undoing={undoing}
        />
      )}

      {/* Debug log panel — always present, toggled by bug icon in bottom-left */}
      <LogPanel />
    </div>
  );
}