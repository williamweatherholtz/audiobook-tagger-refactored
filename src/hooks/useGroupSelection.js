// src/hooks/useGroupSelection.js
// Manages group/book selection state: which groups are selected, expanded,
// and the active single-group detail view.
//
// Extracted from ScannerPage.jsx to reduce its size and isolate selection logic.

import { useState, useEffect } from 'react';

/**
 * @param {object} opts
 * @param {Array}  opts.groups - All book groups (needed for select-all operations)
 * @param {object} opts.fileSelection - Return value of useFileSelection()
 */
export function useGroupSelection({ groups, fileSelection }) {
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
  } = fileSelection;

  const [selectedGroup, setSelectedGroup] = useState(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState(new Set());
  const [expandedGroups, setExpandedGroups] = useState(new Set());

  // Keep selectedGroup in sync when groups are updated (e.g., after rescan)
  useEffect(() => {
    if (selectedGroup) {
      const updatedGroup = groups.find(g => g.id === selectedGroup.id);
      if (updatedGroup && updatedGroup !== selectedGroup) {
        setSelectedGroup(updatedGroup);
      }
    }
  }, [groups, selectedGroup]);

  /**
   * Click handler for a group row. Supports:
   *   - Regular click: select this group only
   *   - Shift+click: range select from last clicked
   *   - Cmd/Ctrl+click: toggle this group in selection
   */
  const handleGroupClick = (group, index, event, filteredGroups = null) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.preventDefault();
    }

    setSelectedGroup(group);

    if (allSelected) {
      setAllSelected(false);
    }

    const groupsToUse = filteredGroups || groups;

    if (event.shiftKey && lastSelectedIndex !== null) {
      const start = Math.min(lastSelectedIndex, index);
      const end = Math.max(lastSelectedIndex, index);
      const newSelectedFiles = new Set(selectedFiles);
      const newSelectedGroupIds = new Set(selectedGroupIds);
      for (let i = start; i <= end; i++) {
        const g = groupsToUse[i];
        if (g) {
          newSelectedGroupIds.add(g.id);
          g.files.forEach(f => newSelectedFiles.add(f.id));
        }
      }
      setSelectedFiles(newSelectedFiles);
      setSelectedGroupIds(newSelectedGroupIds);
    } else if (event.metaKey || event.ctrlKey) {
      const newSelectedFiles = new Set(selectedFiles);
      const newSelectedGroupIds = new Set(selectedGroupIds);
      if (newSelectedGroupIds.has(group.id)) {
        newSelectedGroupIds.delete(group.id);
        group.files.forEach(f => newSelectedFiles.delete(f.id));
      } else {
        newSelectedGroupIds.add(group.id);
        group.files.forEach(f => newSelectedFiles.add(f.id));
      }
      setSelectedFiles(newSelectedFiles);
      setSelectedGroupIds(newSelectedGroupIds);
    } else {
      const newSelectedFiles = new Set();
      const newSelectedGroupIds = new Set();
      newSelectedGroupIds.add(group.id);
      group.files.forEach(f => newSelectedFiles.add(f.id));
      setSelectedFiles(newSelectedFiles);
      setSelectedGroupIds(newSelectedGroupIds);
    }

    setLastSelectedIndex(index);
  };

  /** Checkbox select/deselect a single group. */
  const handleSelectGroup = (group, checked) => {
    selectAllInGroup(group, checked);
    setSelectedGroupIds(prev => {
      const newSet = new Set(prev);
      if (checked) newSet.add(group.id); else newSet.delete(group.id);
      return newSet;
    });
  };

  /** Select all groups in the full library. */
  const handleSelectAll = () => {
    selectAll(groups);
    setSelectedGroupIds(new Set()); // allSelected flag covers this
  };

  /** Select only the groups currently visible through active filters. */
  const handleSelectFiltered = (filteredGroups) => {
    if (!filteredGroups || filteredGroups.length === 0) return;
    if (filteredGroups.length === groups.length) {
      selectAll(groups);
      setSelectedGroupIds(new Set());
    } else {
      clearSelection();
      setSelectedGroupIds(new Set(filteredGroups.map(g => g.id)));
    }
  };

  /** Clear all selections. */
  const handleClearSelection = () => {
    clearSelection();
    setSelectedGroupIds(new Set());
  };

  /** Toggle expand/collapse for a single group row. */
  const toggleGroup = (groupId) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.has(groupId) ? next.delete(groupId) : next.add(groupId);
      return next;
    });
  };

  return {
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
  };
}
