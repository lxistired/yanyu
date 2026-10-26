import {useEffect, useId, useRef, useState} from 'react';

export type FilterValue = string | number;
export type FilterSelection<K extends string, V extends FilterValue> = Readonly<Record<K, readonly V[]>>;
export interface FilterGroup<K extends string, V extends FilterValue> {
  readonly id: K;
  readonly label: string;
  readonly choices: readonly {readonly value: V; readonly label: string}[];
}
export type DismissReason = 'cancel' | 'escape' | 'outside';
export interface StagedStatusFilterProps<K extends string, V extends FilterValue> {
  /** Opt-in row anatomy; default consumers keep their native checkbox presentation. */
  optionPresentation?: 'trailing-check';
  groups: readonly FilterGroup<K, V>[];
  /** Empty arrays mean All, without reserving any user value as a sentinel. */
  value: FilterSelection<K, V>;
  open: boolean;
  onOpenChange: (open: boolean, reason: 'open' | 'confirm' | DismissReason) => boolean | void;
  /** Return false to reject synchronously and keep the draft editable. */
  onCommit: (value: FilterSelection<K, V>) => boolean | void;
  onCancel?: (reason: DismissReason) => void;
  labels?: Partial<{trigger: string; title: string; all: string; reset: string; confirm: string; cancel: string; badge: string; stale: string; rejected: string; pending: string; external: string}>;
}

function copy<K extends string, V extends FilterValue>(value: FilterSelection<K, V>, groups: readonly FilterGroup<K, V>[]) {
  return Object.fromEntries(groups.map(group => [group.id, value[group.id].filter((v, i, a) => a.findIndex(x => Object.is(x, v)) === i)])) as Record<K, V[]>;
}

/** Original generic UI candidate. No backend vocabulary, query or application wiring. */
export function StagedStatusFilter<K extends string, V extends FilterValue>(props: StagedStatusFilterProps<K, V>) {
  const {groups, value, open, onOpenChange} = props;
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const labels = {trigger: 'Filter', title: 'Filter options', all: 'All', reset: 'Reset', confirm: 'Confirm', cancel: 'Cancel', badge: 'selected filters', stale: 'Some selected options are no longer available. Choose All in the affected group or Reset before confirming.', rejected: 'Changes were not accepted. Your draft is still available.', external: 'Committed filters changed while you were editing. Confirm replaces them with this draft; Cancel keeps the latest committed filters.', pending: 'Close requested. Your draft is retained until the parent closes this editor.', ...props.labels};
  const count = groups.reduce((sum, group) => sum + copy(value, [group])[group.id].length, 0);
  return <div ref={root}>
    <button ref={trigger} type="button" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => {if (!open) onOpenChange(true, 'open');}}>
      {labels.trigger} <span aria-label={`${count} ${labels.badge}`}>{count}</span>
    </button>
    {open && <Editor key={JSON.stringify(groups.map(group => group.id))} {...props} labels={labels} id={id} root={root} trigger={trigger} />}
  </div>;
}

function Editor<K extends string, V extends FilterValue>({optionPresentation, groups, value, onOpenChange, onCommit, onCancel, labels, id, root, trigger}: StagedStatusFilterProps<K, V> & {
  labels: {trigger: string; title: string; all: string; reset: string; confirm: string; cancel: string; badge: string; stale: string; rejected: string; pending: string; external: string};
  id: string;
  root: React.RefObject<HTMLDivElement | null>;
  trigger: React.RefObject<HTMLButtonElement | null>;
}) {
  // Opening owns a fresh clone. External replacements update the badge, not this draft.
  const [draft, setDraft] = useState(() => copy(value, groups));
  const [opening] = useState(() => copy(value, groups));
  const external = groups.some(group => {const current = copy(value, [group])[group.id]; return current.length !== opening[group.id].length || current.some((v, i) => !Object.is(v, opening[group.id][i]));});
  const dialog = useRef<HTMLDivElement>(null);
  const decided = useRef(false);
  const [pending, setPending] = useState(false);
  const [rejected, setRejected] = useState(false);
  const stale = groups.some(group => draft[group.id].some(value => !group.choices.some(choice => Object.is(value, choice.value))));
  const dismiss = (reason: DismissReason) => {
    try {
      onCancel?.(reason);
      if (onOpenChange(false, reason) === false) {decided.current = false; setPending(false); setRejected(true); return;}
      setPending(true);
    } catch {decided.current = false; setPending(false); setRejected(true);}
  };
  useEffect(() => {
    dialog.current?.focus();
    const opener = trigger.current;
    return () => { if (document.activeElement === document.body || root.current?.contains(document.activeElement)) opener?.focus(); };
  }, [root, trigger]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {if (event.target instanceof Node && !root.current?.contains(event.target)) dismiss('outside');};
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  });
  const toggle = (group: K, option: V) => setDraft(previous => {
    const selected = previous[group];
    return {...previous, [group]: selected.some(v => Object.is(v, option)) ? selected.filter(v => !Object.is(v, option)) : [...selected, option]};
  });
  const optionLabel = (text: string, selected: boolean) => optionPresentation === 'trailing-check'
    ? <><span className="staged-status-filter__text">{text}</span>{selected && <svg className="staged-status-filter__check" aria-hidden="true" focusable="false" width="20" height="20" viewBox="0 0 20 20"><path d="m4 10 4 4 8-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}</>
    : text;
  return <div id={id} role="dialog" aria-labelledby={`${id}-title`} tabIndex={-1} ref={dialog} onKeyDown={event => {if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); dismiss('escape');}}}>
    <h2 id={`${id}-title`}>{labels.title}</h2>
    {external && <p role="status">{labels.external}</p>}
    {stale && <p role="alert">{labels.stale}</p>}
    {rejected && <p role="alert">{labels.rejected}</p>}
    {pending && <p role="status">{labels.pending}</p>}
    {groups.map(group => <fieldset key={group.id} disabled={pending} className={optionPresentation === 'trailing-check' ? 'staged-status-filter--trailing-check' : undefined}>
      <legend>{group.label}</legend>
      <label><input type="checkbox" checked={draft[group.id].length === 0} onChange={() => setDraft(previous => ({...previous, [group.id]: []}))} />{optionLabel(labels.all, draft[group.id].length === 0)}</label>
      {group.choices.map((choice, index) => <label key={index}><input type="checkbox" checked={draft[group.id].some(v => Object.is(v, choice.value))} onChange={() => toggle(group.id, choice.value)} />{optionLabel(choice.label, draft[group.id].some(v => Object.is(v, choice.value)))}</label>)}
    </fieldset>)}
    <button type="button" disabled={pending} onClick={() => setDraft(Object.fromEntries(groups.map(group => [group.id, [] as V[]])) as Record<K, V[]>)}>{labels.reset}</button>
    <button type="button" onClick={() => dismiss('cancel')}>{labels.cancel}</button>
    <button type="button" disabled={pending || stale} onClick={() => {
      if (decided.current || stale) return;
      try {
      if (onCommit(copy(draft, groups)) === false) {setRejected(true); return;}
      if (onOpenChange(false, 'confirm') === false) {setRejected(true); return;}
      decided.current = true;
      setPending(true);
      } catch {decided.current = false; setPending(false); setRejected(true);}
    }}>{labels.confirm}</button>
  </div>;
}
