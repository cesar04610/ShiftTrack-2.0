import { useEffect, useMemo, useRef, useState } from 'react';

export type SearchOption = { value: string; label: string; hint?: string };

// Lowercase without accents, so "zar" finds "Zaragoza" and "cafe" finds "Café".
const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

// Best matches first: name starts with the text, then a word starts with it,
// then it appears anywhere in the name, then only in the hint (product type).
function rank(option: SearchOption, query: string) {
  const name = plain(option.label);
  if (name.startsWith(query)) return 0;
  if (name.split(/[\s\-–.,/()]+/).some((w) => w.startsWith(query))) return 1;
  if (name.includes(query)) return 2;
  if (option.hint && plain(option.hint).includes(query)) return 3;
  return -1;
}

export function search(options: SearchOption[], text: string) {
  const query = plain(text);
  const sorted = [...options].sort((a, b) => a.label.localeCompare(b.label, 'es'));
  if (!query) return sorted;
  return sorted
    .map((option) => ({ option, score: rank(option, query) }))
    .filter((r) => r.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map((r) => r.option);
}

// A text box that filters a list as you type; the chosen value travels in a hidden input.
export default function SearchSelect({
  id,
  name,
  options,
  required,
  placeholder = 'Escribe para buscar…',
}: {
  id: string;
  name: string;
  options: SearchOption[];
  required?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState(''),
    [chosen, setChosen] = useState<SearchOption | null>(null),
    [open, setOpen] = useState(false),
    [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null),
    list = useRef<HTMLUListElement>(null);
  const matches = useMemo(() => search(options, query), [options, query]);
  const listId = `${id}-list`;

  // The form clears itself after saving; start the search over with it.
  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    const clear = () => {
      setQuery('');
      setChosen(null);
      setOpen(false);
    };
    form.addEventListener('reset', clear);
    return () => form.removeEventListener('reset', clear);
  }, []);
  // Typed text that is not one of the options cannot be submitted.
  useEffect(() => {
    input.current?.setCustomValidity(
      query && !chosen ? 'Elige una opción de la lista de resultados.' : '',
    );
  }, [query, chosen]);
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  function pick(option: SearchOption) {
    setChosen(option);
    setQuery(option.label);
    setOpen(false);
  }
  return (
    <div className="search-select">
      <input
        ref={input}
        id={id}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder={placeholder}
        required={required}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setChosen(null);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, matches.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter' && open && matches[active]) {
            // Enter picks the highlighted result instead of submitting the form.
            e.preventDefault();
            pick(matches[active]);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      <input type="hidden" name={name} value={chosen?.value || ''} />
      {open && (
        <ul className="search-select-list" id={listId} role="listbox" ref={list}>
          {matches.length ? (
            matches.map((option, i) => (
              <li
                key={option.value}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : ''}
                // Keep focus in the text box so the click lands before the list closes.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(option);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span>{option.label}</span>
                {option.hint && <small>{option.hint}</small>}
              </li>
            ))
          ) : (
            <li className="search-select-empty">Sin resultados para «{query}».</li>
          )}
        </ul>
      )}
    </div>
  );
}
