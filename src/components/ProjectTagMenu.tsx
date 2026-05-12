import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical, Trash2 } from 'lucide-react';
import {
  PROJECT_TAG_OPTIONS,
  deleteProject,
  isDbConfigured,
  projectTagLabel,
  updateProjectTag,
} from '../utils/db';

export function projectTagTone(value: string | null | undefined): string {
  switch (value) {
    case 'in_progress':
      return 'bg-blue-100 text-blue-800';
    case 'pending':
      return 'bg-amber-100 text-amber-900';
    case 'on_hold':
      return 'bg-orange-100 text-orange-900';
    case 'closed':
      return 'bg-slate-200 text-slate-800';
    case 'won':
      return 'bg-green-100 text-green-800';
    case 'lost':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-slate-100 text-slate-600';
  }
}

interface ProjectTagMenuProps {
  projectId: string;
  currentTag: string | null;
  /** Called after tag save or after project delete. */
  onTagUpdated: (tag: string | null) => void;
  /** When set, menu includes “Delete project” and calls this after successful delete. */
  onProjectDeleted?: (projectId: string) => void;
  /** Smaller trigger (e.g. table row). */
  compact?: boolean;
}

export default function ProjectTagMenu({
  projectId,
  currentTag,
  onTagUpdated,
  onProjectDeleted,
  compact = false,
}: ProjectTagMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  const applyTag = async (tag: string | null) => {
    if (!isDbConfigured()) return;
    try {
      await updateProjectTag(projectId, tag);
      onTagUpdated(tag);
      setOpen(false);
    } catch (err) {
      console.error('[ProjectTagMenu] update tag', err);
    }
  };

  const handleDelete = async () => {
    if (!isDbConfigured() || !onProjectDeleted) return;
    if (!window.confirm('Delete this project and all related data (sections, quotes, reports)? This cannot be undone.')) {
      return;
    }
    try {
      await deleteProject(projectId);
      setOpen(false);
      onProjectDeleted(projectId);
    } catch (err) {
      console.error('[ProjectTagMenu] delete project', err);
    }
  };

  const label = projectTagLabel(currentTag);

  const menu = open && menuPos
    ? createPortal(
        <div
          role="menu"
          style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }}
          className="z-[9999] w-52 rounded-xl border border-slate-200 bg-white py-1 shadow-xl ring-1 ring-black/5"
        >
          {label && (
            <div className="border-b border-slate-100 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Current</p>
              <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${projectTagTone(currentTag)}`}>
                {label}
              </span>
            </div>
          )}
          <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Set status</p>
          {PROJECT_TAG_OPTIONS.map(opt => (
            <button
              key={opt.value}
              type="button"
              role="menuitem"
              onClick={e => {
                e.stopPropagation();
                void applyTag(opt.value);
              }}
              className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 ${
                currentTag === opt.value ? 'font-semibold text-blue-700' : ''
              }`}
            >
              {opt.label}
              {currentTag === opt.value && <span className="text-blue-600">✓</span>}
            </button>
          ))}
          <div className="my-1 border-t border-slate-100" />
          <button
            type="button"
            role="menuitem"
            onClick={e => {
              e.stopPropagation();
              void applyTag(null);
            }}
            className="w-full px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
          >
            Clear tag
          </button>
          {onProjectDeleted && (
            <>
              <div className="my-1 border-t border-slate-100" />
              <button
                type="button"
                role="menuitem"
                onClick={e => {
                  e.stopPropagation();
                  void handleDelete();
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-semibold text-red-600 hover:bg-red-50"
              >
                <Trash2 size={14} aria-hidden />
                Delete project
              </button>
            </>
          )}
        </div>,
        document.body
      )
    : null;

  return (
    <div className="relative" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        onClick={e => {
          e.stopPropagation();
          if (open) {
            setOpen(false);
          } else {
            const rect = btnRef.current!.getBoundingClientRect();
            setMenuPos({
              top: rect.bottom + 4,
              right: window.innerWidth - rect.right,
            });
            setOpen(true);
          }
        }}
        className={`touch-manipulation flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900 ${
          compact ? 'h-8 w-8' : 'h-9 w-9'
        }`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Project status and actions"
      >
        <MoreVertical size={compact ? 16 : 18} aria-hidden />
      </button>
      {menu}
    </div>
  );
}
