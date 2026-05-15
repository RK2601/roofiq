import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MoreVertical, Trash2 } from 'lucide-react';
import {
  QUOTE_TAG_OPTIONS,
  deleteProjectQuote,
  isDbConfigured,
  projectTagLabel,
  updateQuoteTag,
} from '../utils/db';
import { projectTagTone } from './ProjectTagMenu';
import { ANCHORED_MENU_WIDTH_PX, computeAnchoredMenuPosition, type AnchoredMenuPosition } from '../utils/anchoredMenuPosition';

interface QuoteTagMenuProps {
  quoteId: string;
  currentTag: string | null;
  onTagUpdated: (tag: string | null) => void;
  /** Called after the quote row is deleted from the database. */
  onQuoteDeleted?: (quoteId: string) => void;
  compact?: boolean;
}

export default function QuoteTagMenu({
  quoteId,
  currentTag,
  onTagUpdated,
  onQuoteDeleted,
  compact = false,
}: QuoteTagMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<AnchoredMenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuPortalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (menuPortalRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !btnRef.current || !menuPortalRef.current) return;
    const anchor = btnRef.current.getBoundingClientRect();
    const menuHeight = menuPortalRef.current.offsetHeight;
    setMenuPos(computeAnchoredMenuPosition(anchor, menuHeight));
  }, [open, currentTag, onQuoteDeleted]);

  const applyTag = async (tag: string | null) => {
    if (!isDbConfigured()) {
      window.alert(
        'Database is not connected. Add VITE_DATABASE_URL or DATABASE_URL (your Neon connection string) to .env, restart the dev server, and ensure the variable is available when you run production builds (e.g. on Vercel).'
      );
      return;
    }
    try {
      await updateQuoteTag(quoteId, tag);
      onTagUpdated(tag);
      setOpen(false);
    } catch (err) {
      console.error('[QuoteTagMenu] update tag', err);
      window.alert(
        `Could not update quote status: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleDelete = async () => {
    if (!onQuoteDeleted) return;
    if (!isDbConfigured()) {
      window.alert(
        'Database is not connected. Add VITE_DATABASE_URL or DATABASE_URL (your Neon connection string) to .env, restart the dev server, and ensure the variable is available when you run production builds (e.g. on Vercel).'
      );
      return;
    }
    if (!window.confirm('Delete this quote? This cannot be undone.')) {
      return;
    }
    try {
      await deleteProjectQuote(quoteId);
      setOpen(false);
      onQuoteDeleted(quoteId);
    } catch (err) {
      console.error('[QuoteTagMenu] delete quote', err);
      window.alert(
        `Could not delete quote: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const label = projectTagLabel(currentTag);

  const menu = open && menuPos
    ? createPortal(
        <div
          ref={menuPortalRef}
          role="menu"
          style={{
            position: 'fixed',
            top: menuPos.top,
            right: menuPos.right,
            width: ANCHORED_MENU_WIDTH_PX,
            ...(menuPos.maxHeight != null
              ? { maxHeight: menuPos.maxHeight, overflowY: 'auto' as const }
              : {}),
          }}
          className="z-[9999] rounded-xl border border-slate-200 bg-white py-1 shadow-xl ring-1 ring-black/5"
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
          {QUOTE_TAG_OPTIONS.map(opt => (
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
          {onQuoteDeleted && (
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
                Delete quote
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
            setMenuPos(computeAnchoredMenuPosition(rect, 320));
            setOpen(true);
          }
        }}
        className={`touch-manipulation flex items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 shadow-sm transition-colors hover:bg-slate-50 hover:text-slate-900 ${
          compact ? 'h-8 w-8' : 'h-9 w-9'
        }`}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label="Quote status"
      >
        <MoreVertical size={compact ? 16 : 18} aria-hidden />
      </button>
      {menu}
    </div>
  );
}
