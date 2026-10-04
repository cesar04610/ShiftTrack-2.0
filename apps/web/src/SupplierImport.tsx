import { useEffect, useId, useRef, useState } from 'react';
import { download, uploadSupplierExcel } from './api';

type Preview = {
  sheet: string;
  preview_hash: string;
  summary: { total: number; new: number; duplicate: number; invalid: number };
  rows: {
    row: number;
    company: string;
    representative: string;
    phone: string;
    product_type: string;
    status: 'new' | 'duplicate' | 'invalid';
    message: string;
  }[];
};
export default function SupplierImport({
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
    [saved, setSaved] = useState<{ imported: number; skipped: number }>();
  const dialog = useRef<HTMLDialogElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    operation = useRef(crypto.randomUUID()),
    active = useRef(true),
    title = useId(),
    description = useId();
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
  function close() {
    if (!busy) {
      setOpen(false);
      setFile(undefined);
      setPreview(undefined);
      setSaved(undefined);
      setError('');
      if (fileInput.current) fileInput.current.value = '';
    }
  }
  async function review() {
    if (!file) return;
    setBusy(true);
    setError('');
    setSaved(undefined);
    try {
      const result = await uploadSupplierExcel(branchId, file, 'preview');
      if (active.current) setPreview(result);
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!file || !preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await uploadSupplierExcel(
        branchId,
        file,
        'confirm',
        operation.current,
        preview.preview_hash,
      );
      if (!active.current) return;
      setSaved(result);
      setPreview(undefined);
      setFile(undefined);
      if (fileInput.current) fileInput.current.value = '';
      operation.current = crypto.randomUUID();
      try {
        await onImported();
      } catch {
        setError('Los proveedores se guardaron. Actualiza la página para ver el directorio.');
      }
    } catch (e) {
      if (active.current) setError((e as Error).message);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  return (
    <>
      <button
        className="secondary"
        disabled={!online}
        title={online ? undefined : 'Conéctate a Internet para importar proveedores.'}
        onClick={() => setOpen(true)}
      >
        Importar proveedores desde Excel
      </button>
      <dialog
        ref={dialog}
        className="supplier-import-dialog"
        aria-labelledby={title}
        aria-describedby={description}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <h2 id={title}>Importar proveedores desde Excel</h2>
        <p id={description}>
          Sucursal: <strong>{branchName}</strong>. Revisa los datos antes de agregarlos al
          directorio.
        </p>
        <p>
          Usa las columnas <strong>Empresa, Representante, Teléfono y Tipo de producto</strong>.
          Solo Empresa es obligatoria. Los nombres de empresa repetidos se omiten; los proveedores
          existentes conservan sus datos.
        </p>
        <button
          className="secondary"
          disabled={busy}
          onClick={() =>
            download(
              `/suppliers/import/template?branch_id=${encodeURIComponent(branchId)}`,
              'plantilla-proveedores.xlsx',
            ).catch((e) => setError(e.message))
          }
        >
          Descargar plantilla Excel
        </button>
        <div className="field import-file">
          <label htmlFor={`${title}-file`}>
            Archivo Excel (.xlsx · hasta 2 MB y 2,000 proveedores)
          </label>
          <input
            id={`${title}-file`}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            ref={fileInput}
            onChange={(e) => {
              const selected = e.target.files?.[0];
              setPreview(undefined);
              setSaved(undefined);
              setError('');
              setFile(undefined);
              operation.current = crypto.randomUUID();
              if (selected && !selected.name.toLowerCase().endsWith('.xlsx'))
                setError('Guarda el archivo como Excel .xlsx.');
              else if (selected && selected.size > 2 * 1024 * 1024)
                setError('El archivo supera el límite de 2 MB.');
              else setFile(selected);
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
            <strong>Registro guardado correctamente.</strong>
            <p>
              Proveedores agregados: {saved.imported}. Repetidos omitidos: {saved.skipped}.
            </p>
          </div>
        )}
        {preview && (
          <>
            <p role="status">
              Hoja: {preview.sheet}. <strong>{preview.summary.new} nuevos</strong>,{' '}
              {preview.summary.duplicate} repetidos y {preview.summary.invalid} con errores.
            </p>
            {preview.summary.invalid > 0 && (
              <p className="error">
                Corrige las filas señaladas en Excel y vuelve a cargar el archivo para poder
                importar.
              </p>
            )}
            <div className="table-wrap import-preview">
              <table>
                <thead>
                  <tr>
                    {[
                      'Fila',
                      'Empresa',
                      'Representante',
                      'Teléfono',
                      'Tipo de producto',
                      'Resultado',
                    ].map((header) => (
                      <th key={header}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.row}>
                      <td>{row.row}</td>
                      <td>{row.company || '—'}</td>
                      <td>{row.representative || '—'}</td>
                      <td>{row.phone || '—'}</td>
                      <td>{row.product_type || '—'}</td>
                      <td>{row.status === 'new' ? 'Se agregará' : row.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="import-actions">
          {preview ? (
            <button
              disabled={busy || preview.summary.invalid > 0 || preview.summary.new === 0}
              onClick={confirm}
            >
              {busy
                ? 'Importando…'
                : `Importar ${preview.summary.new} ${preview.summary.new === 1 ? 'proveedor' : 'proveedores'}`}
            </button>
          ) : (
            <button disabled={busy || !file} onClick={review}>
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
