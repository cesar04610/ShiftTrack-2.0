import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { money, parseMoney } from '../../../packages/domain/index.js';
import { loadCatalog, type CatalogProduct } from './offline';
import { request, uploadCatalog } from './api';

// Backup point of sale, used when SICAR is down. It follows SICAR's keys so cashiers already
// know it: scan or type a code, F2 searches, F5 sets the quantity, F6 deletes, Esc charges.
export const MAX_LINES = 150;
type Line = { key: number; product: CatalogProduct; quantity: number };
type Modal =
  | null
  | { type: 'search' }
  | { type: 'quantity'; key: number }
  | { type: 'clear' }
  | { type: 'pay' }
  | { type: 'summary' }
  | { type: 'change'; total: number; received: number; payment: 'cash' | 'card' };
export type TurnSummary = { count: number; total: bigint; cash: bigint; card: bigint };

const pesos = (cents: number | bigint) => money(String(cents));
const fold = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
// Quantities are thousandths: 1000 is one piece or one kilo.
export const lineTotal = (quantity: number, price: number) =>
  Math.floor((quantity * price + 500) / 1000);
const quantityLabel = (line: { product: CatalogProduct; quantity: number }) =>
  line.product.bulk
    ? `${(line.quantity / 1000).toFixed(3)} kg`
    : String(Number((line.quantity / 1000).toFixed(3)));

// The sales a cashier still has to hand over: everything since their last cut, at most one day.
export function turnSales(data: any, userId: string): TurnSummary {
  const lastCut = Math.max(
    Date.now() - 86_400_000,
    ...(data?.cuts || [])
      .filter((c: any) => c.user_id === userId)
      .map((c: any) => Date.parse(c.occurred_at) || 0),
  );
  const summary = { count: 0, total: 0n, cash: 0n, card: 0n };
  for (const sale of data?.sales || []) {
    if (!(Date.parse(sale.occurred_at) > lastCut)) continue;
    const amount = BigInt(sale.total_cents);
    summary.count++;
    summary.total += amount;
    summary[sale.payment === 'card' ? 'card' : 'cash'] += amount;
  }
  return summary;
}

function catalogIndex(products: CatalogProduct[]) {
  const byCode = new Map<string, CatalogProduct>(),
    byDigits = new Map<string, CatalogProduct | null>();
  for (const p of products) byCode.set(p.clave.toLowerCase(), p);
  // A product's own code wins over another product's alternate code.
  for (const p of products)
    if (p.alt && !byCode.has(p.alt.toLowerCase())) byCode.set(p.alt.toLowerCase(), p);
  // Scanners differ on the leading zeros of a barcode; accept them when only one product fits.
  for (const p of products)
    for (const code of [p.clave, p.alt]) {
      const digits = /^\d+$/.test(code) ? code.replace(/^0+/, '') : '';
      if (digits)
        byDigits.set(digits, byDigits.has(digits) && byDigits.get(digits) !== p ? null : p);
    }
  const haystack = products.map((p) => fold(`${p.description} ${p.clave} ${p.alt}`));
  return {
    find(code: string) {
      const key = code.trim().toLowerCase();
      return (
        byCode.get(key) ??
        (/^\d+$/.test(key) ? (byDigits.get(key.replace(/^0+/, '')) ?? undefined) : undefined)
      );
    },
    search(query: string, limit = 60) {
      const words = fold(query).split(/\s+/).filter(Boolean);
      if (!words.length) return [];
      const found: CatalogProduct[] = [],
        first = words[0];
      // Descriptions that start with what was typed go first.
      for (const starts of [true, false])
        for (let i = 0; i < products.length && found.length < limit; i++)
          if (
            haystack[i].startsWith(first) === starts &&
            words.every((word) => haystack[i].includes(word))
          )
            found.push(products[i]);
      return found;
    },
  };
}
function useCatalog(branchId: string, version: number | undefined) {
  const [products, setProducts] = useState<CatalogProduct[] | null>(null);
  useEffect(() => {
    let current = true;
    loadCatalog(branchId)
      .then((list) => current && setProducts(list))
      .catch(() => current && setProducts([]));
    return () => {
      current = false;
    };
  }, [branchId, version]);
  const index = useMemo(() => catalogIndex(products || []), [products]);
  return { products, index };
}

function Dialog({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  const id = useId();
  return (
    <div className="modal-backdrop">
      <div
        className={wide ? 'pos-dialog wide' : 'pos-dialog'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
      >
        <h2 id={id}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
export function TurnSales({ summary }: { summary: TurnSummary }) {
  return (
    <div className="turn-sales">
      <div>
        <span>Ventas totales</span>
        <strong>{pesos(summary.total)}</strong>
        <small>
          {summary.count} {summary.count === 1 ? 'venta' : 'ventas'}
        </small>
      </div>
      <div>
        <span>Efectivo que debes tener</span>
        <strong>{pesos(summary.cash)}</strong>
        <small>Ventas en efectivo</small>
      </div>
      <div>
        <span>Pagos con tarjeta</span>
        <strong>{pesos(summary.card)}</strong>
        <small>Vouchers de la terminal</small>
      </div>
    </div>
  );
}

// The sale in progress survives a visit to another page; it belongs to one user at one branch.
const carts = new Map<string, Line[]>();
let lineKey = 0;

export default function SalesScreen({
  branchId,
  userId,
  catalogVersion,
  registerNumber,
  canSell,
  summary,
  onSell,
  onOpenCut,
}: {
  branchId: string;
  userId: string;
  catalogVersion?: number;
  registerNumber: number | null;
  canSell: boolean;
  summary: TurnSummary;
  onSell: (payload: Record<string, string>) => Promise<void>;
  onOpenCut: () => void;
}) {
  const cartKey = `${branchId}:${userId}`;
  const { products, index } = useCatalog(branchId, catalogVersion);
  const [lines, setLines] = useState<Line[]>(() => carts.get(cartKey) || []),
    [selected, setSelected] = useState<number | null>(null),
    [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [modal, setModal] = useState<Modal>(null),
    [payment, setPayment] = useState<'cash' | 'card'>('cash'),
    [received, setReceived] = useState(''),
    [payError, setPayError] = useState(''),
    [saving, setSaving] = useState(false),
    [query, setQuery] = useState(''),
    [highlight, setHighlight] = useState(0),
    [amount, setAmount] = useState('');
  const codeInput = useRef<HTMLInputElement>(null),
    receivedInput = useRef<HTMLInputElement>(null),
    finishButton = useRef<HTMLButtonElement>(null),
    inputId = useId();
  const total = lines.reduce((sum, l) => sum + lineTotal(l.quantity, l.product.price), 0);
  const results = useMemo(
    () => (modal?.type === 'search' ? index.search(query) : []),
    [modal, query, index],
  );
  const editing = modal?.type === 'quantity' ? lines.find((l) => l.key === modal.key) : undefined;
  useEffect(() => {
    carts.set(cartKey, lines);
  }, [cartKey, lines]);
  useEffect(() => {
    if (!modal) codeInput.current?.focus();
  }, [modal]);
  useEffect(() => {
    if (modal?.type !== 'pay') return;
    if (payment === 'cash') receivedInput.current?.focus();
    else finishButton.current?.focus();
  }, [modal, payment]);
  useEffect(() => {
    document
      .querySelector('.pos-results tr.selected, .pos-lines tr.selected')
      ?.scrollIntoView({ block: 'nearest' });
  }, [highlight, selected, results]);

  function addProduct(product: CatalogProduct) {
    if (product.price <= 0) {
      setError(`«${product.description}» no tiene precio en el catálogo. No se puede vender.`);
      return false;
    }
    const same = product.bulk ? undefined : lines.find((l) => l.product.id === product.id);
    if (!same && lines.length >= MAX_LINES) {
      setError(`Una venta admite hasta ${MAX_LINES} renglones. Cobra esta venta y abre otra.`);
      return false;
    }
    setLines(
      same
        ? lines.map((l) => (l === same ? { ...l, quantity: l.quantity + 1000 } : l))
        : [...lines, { key: ++lineKey, product, quantity: 1000 }],
    );
    setSelected(null);
    setError('');
    return true;
  }
  function submitCode(event: FormEvent) {
    event.preventDefault();
    const text = code.trim();
    setCode('');
    if (!text) return;
    const product = index.find(text);
    if (product) addProduct(product);
    else setError(`Producto no encontrado: ${text}`);
  }
  function openQuantity(line: Line | undefined) {
    if (!line) return;
    setAmount(String(line.product.bulk ? line.quantity : line.quantity / 1000));
    setModal({ type: 'quantity', key: line.key });
  }
  const amountValue = /^\d{1,6}$/.test(amount.trim()) ? Number(amount.trim()) : 0,
    newQuantity = editing ? (editing.product.bulk ? amountValue : amountValue * 1000) : 0;
  function saveQuantity(event: FormEvent) {
    event.preventDefault();
    if (!editing || newQuantity <= 0 || newQuantity > 9_999_000) return;
    setLines(lines.map((l) => (l === editing ? { ...l, quantity: newQuantity } : l)));
    setModal(null);
  }
  function remove() {
    if (selected != null) {
      setLines(lines.filter((l) => l.key !== selected));
      setSelected(null);
    } else if (lines.length) setModal({ type: 'clear' });
  }
  function openPay() {
    if (!lines.length) return;
    setPayment('cash');
    setReceived('');
    setPayError('');
    setModal({ type: 'pay' });
  }
  // An empty amount means the customer paid the exact total.
  let receivedCents: number | null = total;
  if (payment === 'cash' && received.trim())
    try {
      receivedCents = Number(parseMoney(received.trim()));
    } catch {
      receivedCents = null;
    }
  async function finish(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    if (receivedCents === null) return setPayError('Escribe con cuánto paga el cliente.');
    if (receivedCents < total)
      return setPayError(`Faltan ${pesos(total - receivedCents)} para cubrir el total.`);
    setSaving(true);
    setPayError('');
    try {
      await onSell({
        id: crypto.randomUUID(),
        register_number: String(registerNumber),
        payment,
        total_cents: String(total),
        received_cents: String(receivedCents),
        items: JSON.stringify(lines.map((l) => [l.product.id, l.quantity, l.product.price])),
      });
      setLines([]);
      setSelected(null);
      setError('');
      setModal({ type: 'change', total, received: receivedCents, payment });
    } catch (e) {
      setPayError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  function pick(product: CatalogProduct | undefined) {
    if (!product) return;
    addProduct(product);
    setModal(null);
  }

  const keys = useRef<(event: KeyboardEvent) => void>(() => {});
  keys.current = (event) => {
    // The browser's own F5 would reload the page and close the session.
    if (['F2', 'F5', 'F6', 'F8', 'F9', 'F10'].includes(event.key)) event.preventDefault();
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    if (modal) {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (!saving) setModal(null);
      } else if (modal.type === 'pay' && event.key === 'F8') setPayment('cash');
      else if (modal.type === 'pay' && event.key === 'F9') setPayment('card');
      else if (modal.type === 'search' && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        setHighlight((h) =>
          Math.max(0, Math.min(results.length - 1, h + (event.key === 'ArrowDown' ? 1 : -1))),
        );
      }
      return;
    }
    if (!canSell) return;
    const position = lines.findIndex((l) => l.key === selected);
    if (event.key === 'F2') {
      setQuery('');
      setHighlight(0);
      setModal({ type: 'search' });
    } else if (event.key === 'F5') openQuantity(lines[position] ?? lines.at(-1));
    else if (event.key === 'F6') remove();
    else if (event.key === 'F10') setModal({ type: 'summary' });
    else if (event.key === 'Escape') {
      event.preventDefault();
      openPay();
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && lines.length) {
      event.preventDefault();
      const next =
        position < 0
          ? event.key === 'ArrowDown'
            ? 0
            : lines.length - 1
          : position + (event.key === 'ArrowDown' ? 1 : -1);
      setSelected(lines[next]?.key ?? null);
    } else if (event.key.length === 1 && !(document.activeElement instanceof HTMLInputElement))
      // A scan must land in the code box wherever the last click was.
      codeInput.current?.focus();
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keys.current(event);
    window.addEventListener('keydown', listener, true);
    return () => window.removeEventListener('keydown', listener, true);
  }, []);

  if (!canSell)
    return <div className="notice">Selecciona una caja con conexión para registrar ventas.</div>;
  if (products && !products.length)
    return (
      <div className="notice">
        Esta sucursal todavía no tiene catálogo de productos. Un administrador debe importarlo desde
        SICAR en el menú Productos, con conexión a Internet.
      </div>
    );
  const change = receivedCents === null ? null : receivedCents - total;
  return (
    <div className="pos">
      <form className="pos-entry" onSubmit={submitCode}>
        <label htmlFor={inputId}>Código del producto</label>
        <input
          id={inputId}
          ref={codeInput}
          value={code}
          autoComplete="off"
          autoFocus
          placeholder="Escanea el producto o escribe su clave y presiona Enter"
          onChange={(e) => setCode(e.target.value)}
        />
        <button
          type="button"
          className="secondary"
          onClick={() => {
            setQuery('');
            setHighlight(0);
            setModal({ type: 'search' });
          }}
        >
          Buscar (F2)
        </button>
      </form>
      {error && (
        <div className="error pos-error" role="alert">
          {error}
        </div>
      )}
      <div className="table-wrap pos-lines">
        <table>
          <thead>
            <tr>
              <th>Cant.</th>
              <th>Clave</th>
              <th>Descripción</th>
              <th className="number">Precio</th>
              <th className="number">Importe</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr
                key={line.key}
                className={line.key === selected ? 'selected' : ''}
                aria-selected={line.key === selected}
                onClick={() => setSelected(line.key === selected ? null : line.key)}
              >
                <td>
                  <button
                    type="button"
                    className="pos-quantity"
                    title="Cambiar cantidad"
                    aria-label={`Cantidad de ${line.product.description}: ${quantityLabel(line)}. Cambiar`}
                    onClick={(e) => {
                      e.stopPropagation();
                      openQuantity(line);
                    }}
                  >
                    {quantityLabel(line)}
                  </button>
                </td>
                <td>{line.product.clave}</td>
                <td>{line.product.description}</td>
                <td className="number">{pesos(line.product.price)}</td>
                <td className="number">{pesos(lineTotal(line.quantity, line.product.price))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!lines.length && (
          <p className="pos-empty">
            {products ? 'Escanea un producto para empezar la venta.' : 'Cargando catálogo…'}
          </p>
        )}
      </div>
      <div className="pos-footer">
        <div className="pos-keys">
          <button
            type="button"
            className="secondary"
            disabled={!lines.length}
            onClick={() => openQuantity(lines.find((l) => l.key === selected) ?? lines.at(-1))}
          >
            <kbd>F5</kbd> Cantidad / granel
          </button>
          <button type="button" className="secondary" disabled={!lines.length} onClick={remove}>
            <kbd>F6</kbd> {selected != null ? 'Eliminar producto' : 'Eliminar todo'}
          </button>
          <button type="button" className="secondary" onClick={() => setModal({ type: 'summary' })}>
            <kbd>F10</kbd> Ventas del turno
          </button>
          <button type="button" className="primary" disabled={!lines.length} onClick={openPay}>
            <kbd>Esc</kbd> Cobrar
          </button>
        </div>
        <div className="pos-total" aria-live="polite">
          <span>
            {lines.length} {lines.length === 1 ? 'renglón' : 'renglones'}
          </span>
          <small>TOTAL</small>
          <strong>{pesos(total)}</strong>
        </div>
      </div>

      {modal?.type === 'search' && (
        <Dialog title="Buscar producto" wide>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              pick(results[highlight]);
            }}
          >
            <input
              autoFocus
              aria-label="Buscar por descripción o clave"
              placeholder="Escribe parte de la descripción o la clave"
              value={query}
              autoComplete="off"
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
            />
          </form>
          <div className="table-wrap pos-results">
            <table>
              <thead>
                <tr>
                  <th>Clave</th>
                  <th>Descripción</th>
                  <th className="number">Precio</th>
                </tr>
              </thead>
              <tbody>
                {results.map((p, i) => (
                  <tr
                    key={p.id}
                    className={i === highlight ? 'selected' : ''}
                    onClick={() => pick(p)}
                  >
                    <td>{p.clave}</td>
                    <td>
                      {p.description}
                      {p.bulk && <em className="pos-tag">Granel</em>}
                    </td>
                    <td className="number">{p.price > 0 ? pesos(p.price) : 'Sin precio'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!results.length && (
              <p className="pos-empty">
                {query.trim() ? 'Ningún producto coincide.' : 'Escribe para buscar en el catálogo.'}
              </p>
            )}
          </div>
          <p className="pos-hint">
            <kbd>↑</kbd> <kbd>↓</kbd> elegir · <kbd>Enter</kbd> agregar · <kbd>Esc</kbd> cerrar
          </p>
        </Dialog>
      )}

      {editing && (
        <Dialog title={editing.product.description}>
          <form onSubmit={saveQuantity}>
            <div className="field">
              <label htmlFor={`${inputId}-quantity`}>
                {editing.product.bulk ? 'Cantidad en gramos' : 'Cantidad de piezas'}
              </label>
              <input
                id={`${inputId}-quantity`}
                autoFocus
                inputMode="numeric"
                autoComplete="off"
                value={amount}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <p className="pos-preview">
              {newQuantity > 0 ? (
                <>
                  {editing.product.bulk && <>{(newQuantity / 1000).toFixed(3)} kg · </>}
                  Importe: <strong>{pesos(lineTotal(newQuantity, editing.product.price))}</strong>
                </>
              ) : editing.product.bulk ? (
                'Escribe los gramos, sin decimales. Un kilo son 1000.'
              ) : (
                'Escribe un número entero de piezas.'
              )}
            </p>
            <div className="import-actions">
              <button type="submit" className="primary" disabled={newQuantity <= 0}>
                Aceptar (Enter)
              </button>
              <button type="button" className="secondary" onClick={() => setModal(null)}>
                Cancelar (Esc)
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {modal?.type === 'clear' && (
        <Dialog title="¿Deseas borrar todos los productos?">
          <p>
            Se quitarán los {lines.length} renglones de esta venta. No hay ningún producto
            seleccionado.
          </p>
          <div className="import-actions">
            <button
              type="button"
              className="danger"
              autoFocus
              onClick={() => {
                setLines([]);
                setError('');
                setModal(null);
              }}
            >
              Sí, borrar todo (Enter)
            </button>
            <button type="button" className="secondary" onClick={() => setModal(null)}>
              No (Esc)
            </button>
          </div>
        </Dialog>
      )}

      {modal?.type === 'pay' && (
        <Dialog title="Cobrar">
          <form onSubmit={finish}>
            <div className="pos-amount">
              <span>Total</span>
              <strong>{pesos(total)}</strong>
            </div>
            <div className="pos-payment" role="radiogroup" aria-label="Tipo de pago">
              {(
                [
                  ['cash', 'Efectivo', 'F8'],
                  ['card', 'Tarjeta', 'F9'],
                ] as const
              ).map(([value, label, key]) => (
                <button
                  type="button"
                  key={value}
                  role="radio"
                  aria-checked={payment === value}
                  className={payment === value ? 'primary' : 'secondary'}
                  onClick={() => {
                    setPayment(value);
                    setPayError('');
                  }}
                >
                  {label} <kbd>{key}</kbd>
                </button>
              ))}
            </div>
            {payment === 'cash' ? (
              <>
                <div className="field">
                  <label htmlFor={`${inputId}-received`}>Paga con · MXN</label>
                  <input
                    id={`${inputId}-received`}
                    ref={receivedInput}
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder={(total / 100).toFixed(2)}
                    value={received}
                    onChange={(e) => {
                      setReceived(e.target.value);
                      setPayError('');
                    }}
                  />
                </div>
                <div className="pos-amount change">
                  <span>Cambio</span>
                  <strong>{change !== null && change >= 0 ? pesos(change) : '—'}</strong>
                </div>
              </>
            ) : (
              <p className="pos-preview">
                Cobra {pesos(total)} en la terminal y confirma cuando el pago esté aprobado.
              </p>
            )}
            {payError && (
              <div className="error" role="alert">
                {payError}
              </div>
            )}
            <div className="import-actions">
              <button type="submit" className="primary" ref={finishButton} disabled={saving}>
                {saving ? 'Guardando…' : 'Terminar venta (Enter)'}
              </button>
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={() => setModal(null)}
              >
                Volver a la venta (Esc)
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {modal?.type === 'change' && (
        <Dialog title="Venta registrada">
          <div className="pos-amount change big">
            <span>{modal.payment === 'cash' ? 'Cambio entregado' : 'Pago con tarjeta'}</span>
            <strong>
              {pesos(modal.payment === 'cash' ? modal.received - modal.total : modal.total)}
            </strong>
          </div>
          <p className="pos-preview">
            Total {pesos(modal.total)}
            {modal.payment === 'cash' && <> · Pagó con {pesos(modal.received)}</>}
          </p>
          <p className="pos-hint">
            Presiona <kbd>Esc</kbd> para continuar con la siguiente venta.
          </p>
          <button type="button" className="secondary" onClick={() => setModal(null)}>
            Continuar (Esc)
          </button>
        </Dialog>
      )}

      {modal?.type === 'summary' && (
        <Dialog title="Ventas del turno" wide>
          <p>
            Ventas registradas en Mostrador desde tu último corte. Es solo informativo: cuenta tu
            efectivo y captura las cantidades reales en <strong>Mi corte</strong>.
          </p>
          <TurnSales summary={summary} />
          <div className="import-actions">
            <button type="button" className="primary" onClick={onOpenCut}>
              Ir a Mi corte
            </button>
            <button type="button" className="secondary" onClick={() => setModal(null)}>
              Cerrar (Esc)
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

type Preview = {
  preview_hash: string;
  summary: Record<
    | 'total'
    | 'new'
    | 'changed'
    | 'unchanged'
    | 'removed'
    | 'bulk'
    | 'unpriced'
    | 'uneven'
    | 'invalid',
    number
  >;
  invalid: { row: number; clave: string; description: string; message: string }[];
  uneven: { row: number; clave: string; description: string; message: string }[];
  sample: { clave: string; description: string; price_cents: string; bulk: boolean }[];
};
const count = (n: number) => n.toLocaleString('es-MX');
function CatalogImport({
  branchId,
  branchName,
  online,
  onImported,
}: {
  branchId: string;
  branchName: string;
  online: boolean;
  onImported: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false),
    [file, setFile] = useState<File>(),
    [preview, setPreview] = useState<Preview>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [saved, setSaved] = useState<Preview['summary']>();
  const dialog = useRef<HTMLDialogElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    operation = useRef(crypto.randomUUID()),
    active = useRef(true),
    title = useId();
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  function reset() {
    setFile(undefined);
    setPreview(undefined);
    setError('');
    if (fileInput.current) fileInput.current.value = '';
    operation.current = crypto.randomUUID();
  }
  function close() {
    if (busy) return;
    setOpen(false);
    setSaved(undefined);
    reset();
  }
  async function send(mode: 'preview' | 'confirm') {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const result = await uploadCatalog(
        branchId,
        file,
        mode,
        operation.current,
        preview?.preview_hash,
      );
      if (!active.current) return;
      if (mode === 'preview') setPreview(result);
      else {
        reset();
        setSaved(result);
        await onImported().catch(() => {});
      }
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  const s = preview?.summary;
  const issues = (titleText: string, rows: Preview['invalid'], openFirst = false) =>
    rows.length > 0 && (
      <details className="import-issues" open={openFirst}>
        <summary>{titleText}</summary>
        <div className="table-wrap import-preview">
          <table>
            <thead>
              <tr>
                <th>Fila</th>
                <th>Clave</th>
                <th>Descripción</th>
                <th>Detalle</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.row}>
                  <td>{r.row}</td>
                  <td>{r.clave || '—'}</td>
                  <td>{r.description || '—'}</td>
                  <td>{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    );
  return (
    <>
      <button
        className="primary"
        disabled={!online}
        title={online ? undefined : 'Conéctate a Internet para importar el catálogo.'}
        onClick={() => setOpen(true)}
      >
        Importar catálogo de SICAR
      </button>
      <dialog
        ref={dialog}
        className="supplier-import-dialog"
        aria-labelledby={title}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <h2 id={title}>Importar catálogo de SICAR</h2>
        <p>
          Sucursal: <strong>{branchName}</strong>. En SICAR exporta los artículos a Excel y carga
          aquí ese archivo <strong>.xls</strong> tal como sale, sin modificarlo.
        </p>
        <p>
          Solo se guardan clave, clave alterna, descripción, precio 1 y si se vende a granel. Al
          precio se le suman IVA (16%) e IEPS (8%) cuando el artículo los tiene marcados. El archivo
          reemplaza al catálogo: lo que ya no venga en él deja de venderse.
        </p>
        <div className="field import-file">
          <label htmlFor={`${title}-file`}>Archivo de SICAR (.xls · hasta 8 MB)</label>
          <input
            id={`${title}-file`}
            type="file"
            accept=".xls,application/vnd.ms-excel"
            disabled={busy}
            ref={fileInput}
            onChange={(e) => {
              const chosen = e.target.files?.[0];
              setPreview(undefined);
              setSaved(undefined);
              setError('');
              setFile(undefined);
              operation.current = crypto.randomUUID();
              if (chosen && !chosen.name.toLowerCase().endsWith('.xls'))
                setError('Usa el archivo .xls que exporta SICAR.');
              else if (chosen && chosen.size > 8 * 1024 * 1024)
                setError('El archivo supera el límite de 8 MB.');
              else setFile(chosen);
            }}
          />
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {saved && (
          <div className="import-success" role="status">
            <strong>Catálogo guardado correctamente.</strong>
            <p>
              {count(saved.total)} productos a la venta: {count(saved.new)} nuevos,{' '}
              {count(saved.changed)} actualizados y {count(saved.removed)} dados de baja. Cada caja
              lo descarga sola al actualizar su pantalla con conexión.
            </p>
          </div>
        )}
        {s && preview && (
          <>
            <div className="import-summary" role="status">
              <p>
                <strong>{count(s.total)} productos</strong> en el archivo: {count(s.new)} nuevos,{' '}
                {count(s.changed)} con cambios y {count(s.unchanged)} sin cambios. {count(s.bulk)}{' '}
                se venden a granel.
              </p>
              <ul>
                {s.removed > 0 && (
                  <li>
                    <strong>{count(s.removed)}</strong> productos del catálogo actual ya no vienen
                    en el archivo y dejarán de venderse.
                  </li>
                )}
                {s.unpriced > 0 && (
                  <li>
                    <strong>{count(s.unpriced)}</strong> no tienen precio: aparecerán en la
                    búsqueda, pero no se podrán vender.
                  </li>
                )}
                {s.uneven > 0 && (
                  <li>
                    <strong>{count(s.uneven)}</strong> quedan con centavos poco comunes; revisa en
                    SICAR si les falta marcar un impuesto.
                  </li>
                )}
                {s.invalid > 0 && (
                  <li>
                    <strong>{count(s.invalid)}</strong> filas tienen errores y se omitirán.
                  </li>
                )}
              </ul>
            </div>
            {issues('Filas que se omitirán', preview.invalid, true)}
            {issues('Precios con centavos poco comunes', preview.uneven)}
            <details className="import-issues">
              <summary>Muestra de cómo quedan los primeros productos</summary>
              <div className="table-wrap import-preview">
                <table>
                  <thead>
                    <tr>
                      <th>Clave</th>
                      <th>Descripción</th>
                      <th>Precio al público</th>
                      <th>Granel</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.sample.map((p) => (
                      <tr key={p.clave}>
                        <td>{p.clave}</td>
                        <td>{p.description}</td>
                        <td>{money(p.price_cents)}</td>
                        <td>{p.bulk ? 'Sí' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
        <div className="import-actions">
          {preview ? (
            <button className="primary" disabled={busy} onClick={() => send('confirm')}>
              {busy
                ? 'Guardando…'
                : `Guardar catálogo de ${count(preview.summary.total)} productos`}
            </button>
          ) : (
            <button className="primary" disabled={busy || !file} onClick={() => send('preview')}>
              {busy ? 'Revisando…' : 'Revisar archivo'}
            </button>
          )}
          <button className="secondary" disabled={busy} onClick={close}>
            Cerrar
          </button>
        </div>
      </dialog>
    </>
  );
}

// Administration: the catalog and the sales captured in Mostrador.
export function ProductsAdmin({
  branchId,
  branchName,
  online,
  catalog,
  timezone,
  today,
  onImported,
}: {
  branchId: string;
  branchName: string;
  online: boolean;
  catalog?: { version: number; product_count: number; imported_at: string | null };
  timezone: string;
  today: string;
  onImported: () => Promise<void>;
}) {
  const { index } = useCatalog(branchId, catalog?.version);
  const [query, setQuery] = useState(''),
    [date, setDate] = useState(today),
    [sales, setSales] = useState<any[] | null>(null),
    [error, setError] = useState('');
  const found = useMemo(() => index.search(query, 30), [index, query]);
  const lookupId = useId(),
    dateId = useId();
  useEffect(() => {
    let current = true;
    setSales(null);
    setError('');
    if (!online || !date) return;
    request(`/sales?branch_id=${branchId}&date=${date}`)
      .then((r) => current && setSales(r.sales))
      .catch((e) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [branchId, date, online]);
  const cashiers = useMemo(() => {
    const totals = new Map<string, { name: string; count: number; cash: bigint; card: bigint }>();
    for (const sale of sales || []) {
      const row = totals.get(sale.user_id) || {
        name: sale.user_name,
        count: 0,
        cash: 0n,
        card: 0n,
      };
      row.count++;
      row[sale.payment === 'card' ? 'card' : 'cash'] += BigInt(sale.total_cents);
      totals.set(sale.user_id, row);
    }
    return [...totals.values()].sort((x, y) => x.name.localeCompare(y.name, 'es'));
  }, [sales]);
  const hour = (value: string) =>
    new Intl.DateTimeFormat('es-MX', { timeStyle: 'short', timeZone: timezone }).format(
      new Date(value),
    );
  return (
    <>
      <section className="card">
        <div className="card-title">
          <h2>Catálogo de productos</h2>
          <p>
            {catalog?.imported_at
              ? `${count(catalog.product_count)} productos a la venta · última importación ${new Intl.DateTimeFormat(
                  'es-MX',
                  { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone },
                ).format(new Date(catalog.imported_at))}`
              : 'Todavía no se ha importado el catálogo de esta sucursal.'}
          </p>
        </div>
        <p>
          El catálogo se usa en <strong>Ventas</strong> cuando SICAR no está disponible. Vuelve a
          importarlo cada vez que cambien precios o productos en SICAR.
        </p>
        <CatalogImport
          key={branchId}
          branchId={branchId}
          branchName={branchName}
          online={online}
          onImported={onImported}
        />
        <div className="field catalog-lookup">
          <label htmlFor={lookupId}>Consultar un producto del catálogo</label>
          <input
            id={lookupId}
            value={query}
            autoComplete="off"
            placeholder="Descripción o clave"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {query.trim() && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Clave</th>
                  <th>Clave alterna</th>
                  <th>Descripción</th>
                  <th>Precio al público</th>
                  <th>Granel</th>
                </tr>
              </thead>
              <tbody>
                {found.map((p) => (
                  <tr key={p.id}>
                    <td>{p.clave}</td>
                    <td>{p.alt || '—'}</td>
                    <td>{p.description}</td>
                    <td>{p.price > 0 ? pesos(p.price) : 'Sin precio'}</td>
                    <td>{p.bulk ? 'Sí' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!found.length && <p className="pos-empty">Ningún producto coincide.</p>}
          </div>
        )}
      </section>
      <section className="card">
        <div className="card-title">
          <h2>Ventas registradas en Mostrador</h2>
          <p>Ventas capturadas en las cajas por día de trabajo. Los cortes siguen en Cortes.</p>
        </div>
        <div className="field">
          <label htmlFor={dateId}>Día</label>
          <input
            id={dateId}
            type="date"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        {!online && <div className="notice">Conecta a Internet para consultar las ventas.</div>}
        {error && <div className="error">{error}</div>}
        {online && !error && sales === null && <p>Cargando ventas…</p>}
        {sales && !sales.length && <p className="pos-empty">No hay ventas registradas ese día.</p>}
        {sales && sales.length > 0 && (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Cajero</th>
                    <th>Ventas</th>
                    <th>Efectivo</th>
                    <th>Tarjeta</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {cashiers.map((c) => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td>{c.count}</td>
                      <td>{pesos(c.cash)}</td>
                      <td>{pesos(c.card)}</td>
                      <td>{pesos(c.cash + c.card)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="sale-list">
              {sales.map((sale) => (
                <details key={sale.id}>
                  <summary>
                    <span>
                      {hour(sale.occurred_at)} · Caja {sale.register_number} · {sale.user_name}
                    </span>
                    <span>
                      {sale.payment === 'card' ? 'Tarjeta' : 'Efectivo'} ·{' '}
                      <strong>{money(sale.total_cents)}</strong>
                    </span>
                  </summary>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Cant.</th>
                          <th>Clave</th>
                          <th>Descripción</th>
                          <th>Precio</th>
                          <th>Importe</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sale.items.map((item: any, i: number) => (
                          <tr key={i}>
                            <td>{Number((item.quantity_milli / 1000).toFixed(3))}</td>
                            <td>{item.clave}</td>
                            <td>{item.description}</td>
                            <td>{money(item.unit_price_cents)}</td>
                            <td>{money(item.total_cents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {sale.payment === 'cash' && (
                    <p>
                      Pagó con {money(sale.received_cents)} · Cambio {money(sale.change_cents)}
                    </p>
                  )}
                </details>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}
