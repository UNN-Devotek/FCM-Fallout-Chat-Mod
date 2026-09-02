import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router';
import { api } from '../../services/api';
import type { AuthUser } from '../../contexts/AuthContext';

const ADMIN_ROLES = ['owner', 'admin'];

interface BlacklistEntry {
  id: string;
  pattern: string;
  matchType: 'exact' | 'contains' | 'regex';
  enabled: boolean;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

export default function NameBlacklist() {
  const outletCtx = useOutletContext<{ user?: AuthUser }>() || {};
  const isAdmin = ADMIN_ROLES.includes(outletCtx.user?.role || '');
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [newPattern, setNewPattern] = useState('');
  const [newMatchType, setNewMatchType] = useState<'exact' | 'contains' | 'regex'>('exact');
  const [newNote, setNewNote] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const { data, isLoading, error: queryError } = useQuery({
    queryKey: ['name-blacklist'],
    queryFn: () => api.get<BlacklistEntry[]>('/api/admin/name-blacklist'),
  });

  const error = queryError ? (queryError as Error).message : null;

  async function addEntry() {
    if (!isAdmin || !newPattern.trim()) return;
    setActionError(null);
    setActionLoading(true);
    try {
      await api.post('/api/admin/name-blacklist', {
        pattern: newPattern.trim(),
        matchType: newMatchType,
        enabled: true,
        note: newNote.trim() || null,
      });
      setNewPattern('');
      setNewNote('');
      setNewMatchType('exact');
      queryClient.invalidateQueries({ queryKey: ['name-blacklist'] });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  async function toggleEnabled(entry: BlacklistEntry) {
    if (!isAdmin) return;
    setActionError(null);
    setActionLoading(true);
    try {
      await api.patch(`/api/admin/name-blacklist/${entry.id}`, { enabled: !entry.enabled });
      queryClient.invalidateQueries({ queryKey: ['name-blacklist'] });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  async function deleteEntry(id: string) {
    if (!isAdmin) return;
    if (!window.confirm('Delete this blacklist entry?')) return;
    setActionError(null);
    setActionLoading(true);
    try {
      await api.delete(`/api/admin/name-blacklist/${id}`);
      queryClient.invalidateQueries({ queryKey: ['name-blacklist'] });
    } catch (err) {
      setActionError((err as Error).message);
    } finally {
      setActionLoading(false);
    }
  }

  const filteredEntries = (data ?? []).filter(e =>
    !search.trim() ||
    e.pattern.toLowerCase().includes(search.toLowerCase()) ||
    (e.note ?? '').toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold mb-4">Name Blacklist</h1>
      <p className="text-sm opacity-70 mb-4">
        Patterns that must never be accepted as a player's FO76 in-game name.
        The memory-reader on the desktop can latch onto random strings (item
        names, menu labels) during heap-region shifts. Any incoming
        <code className="mx-1 px-1 bg-black/30 rounded">/api/register</code>
        username matching an enabled entry is rejected (placeholder used
        instead) and the desktop is signalled to re-scan.
      </p>

      {error && <div className="p-3 mb-4 bg-red-900/30 border border-red-500/50 text-red-200 rounded">{error}</div>}
      {actionError && <div className="p-3 mb-4 bg-amber-900/30 border border-amber-500/50 text-amber-200 rounded">{actionError}</div>}

      {isAdmin && (
        <div className="mb-6 p-4 border border-current/20 rounded">
          <h2 className="font-semibold mb-3">Add entry</h2>
          <div className="flex flex-wrap gap-2 items-end">
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs opacity-70 mb-1">Pattern</label>
              <input
                type="text"
                value={newPattern}
                onChange={(e) => setNewPattern(e.target.value)}
                placeholder="e.g. Basic Repair Kit"
                className="w-full px-2 py-1 bg-black/30 border border-current/30 rounded text-sm"
              />
            </div>
            <div>
              <label className="block text-xs opacity-70 mb-1">Match type</label>
              <select
                value={newMatchType}
                onChange={(e) => setNewMatchType(e.target.value as 'exact' | 'contains' | 'regex')}
                className="px-2 py-1 bg-black/30 border border-current/30 rounded text-sm"
              >
                <option value="exact">Exact</option>
                <option value="contains">Contains</option>
                <option value="regex">Regex</option>
              </select>
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-xs opacity-70 mb-1">Note (optional)</label>
              <input
                type="text"
                value={newNote}
                onChange={(e) => setNewNote(e.target.value)}
                placeholder="why is this blacklisted?"
                className="w-full px-2 py-1 bg-black/30 border border-current/30 rounded text-sm"
              />
            </div>
            <button
              onClick={addEntry}
              disabled={actionLoading || !newPattern.trim()}
              className="px-4 py-1 bg-current/20 border border-current/40 rounded text-sm hover:bg-current/30 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div className="mb-3 flex items-center gap-2">
        <input
          type="text"
          placeholder="Search pattern or note…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-2 py-1 bg-black/30 border border-current/30 rounded text-sm"
        />
        <span className="text-xs opacity-70">{filteredEntries.length} of {data?.length ?? 0}</span>
      </div>

      {isLoading ? (
        <div className="p-4 text-center opacity-70">Loading…</div>
      ) : filteredEntries.length === 0 ? (
        <div className="p-4 text-center opacity-70">No entries.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase opacity-70 border-b border-current/20">
              <th className="py-2 pr-2">Pattern</th>
              <th className="py-2 px-2">Match</th>
              <th className="py-2 px-2">Enabled</th>
              <th className="py-2 px-2">Note</th>
              <th className="py-2 px-2">Created</th>
              {isAdmin && <th className="py-2 pl-2 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {filteredEntries.map(entry => (
              <tr key={entry.id} className="border-b border-current/10 hover:bg-current/5">
                <td className="py-2 pr-2 font-mono">{entry.pattern}</td>
                <td className="py-2 px-2">{entry.matchType}</td>
                <td className="py-2 px-2">
                  {isAdmin ? (
                    <button
                      onClick={() => toggleEnabled(entry)}
                      disabled={actionLoading}
                      className={`px-2 py-0.5 text-xs rounded border ${
                        entry.enabled
                          ? 'border-emerald-500/50 text-emerald-300 bg-emerald-900/20'
                          : 'border-current/30 opacity-50'
                      }`}
                    >
                      {entry.enabled ? 'ON' : 'OFF'}
                    </button>
                  ) : entry.enabled ? 'ON' : 'OFF'}
                </td>
                <td className="py-2 px-2 opacity-80 max-w-xs truncate" title={entry.note ?? ''}>{entry.note ?? '—'}</td>
                <td className="py-2 px-2 opacity-70 text-xs">{new Date(entry.createdAt).toLocaleDateString()}</td>
                {isAdmin && (
                  <td className="py-2 pl-2 text-right">
                    <button
                      onClick={() => deleteEntry(entry.id)}
                      disabled={actionLoading}
                      className="px-2 py-0.5 text-xs rounded border border-red-500/30 text-red-300 hover:bg-red-900/20"
                    >
                      Delete
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
