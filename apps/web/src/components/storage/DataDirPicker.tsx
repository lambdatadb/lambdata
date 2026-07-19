import { useEffect, useRef, useState } from "react";
import type { PathValidationResponse, PickFolderResponse } from "@kilndb/shared";
import { api, ApiError } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { Button } from "../ui/Button";
import { Field, Input } from "../ui/Input";
import { Icon } from "../ui/Icon";

interface Props {
  value: string;
  onChange: (path: string) => void;
  onValidation?: (v: PathValidationResponse | null) => void;
  /** Suggested preset paths shown as one-click chips. */
  presets?: { label: string; path: string }[];
  /** Disabled while parent is busy submitting. */
  disabled?: boolean;
  /** Text used as the picker dialog prompt. */
  pickerPrompt?: string;
}

export function DataDirPicker({
  value,
  onChange,
  onValidation,
  presets = [],
  disabled,
  pickerPrompt,
}: Props) {
  const [validating, setValidating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [validation, setValidation] = useState<PathValidationResponse | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerSupported, setPickerSupported] = useState(true);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!value.trim()) {
      setValidation(null);
      onValidation?.(null);
      return;
    }
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(async () => {
      setValidating(true);
      try {
        const r = await api.post<PathValidationResponse>("/system/validate-path", { path: value });
        setValidation(r);
        onValidation?.(r);
      } catch (e) {
        const r: PathValidationResponse = {
          ok: false,
          error: e instanceof ApiError ? e.message : "validation failed",
          resolvedPath: value,
          exists: false,
          writable: false,
          freeBytes: null,
          isEmpty: null,
        };
        setValidation(r);
        onValidation?.(r);
      } finally {
        setValidating(false);
      }
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [value]);

  const pick = async () => {
    setPickerError(null);
    setPicking(true);
    try {
      const r = await api.post<PickFolderResponse>("/system/pick-folder", {
        prompt: pickerPrompt,
        default: value || undefined,
      });
      if (r.unsupported) {
        setPickerSupported(false);
        return;
      }
      if (!r.canceled && r.path) onChange(r.path);
    } catch (e) {
      setPickerError(e instanceof ApiError ? e.message : "picker failed");
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="space-y-3">
      <Field label="Path" hint="Absolute path. ~/ is expanded.">
        <div className="flex gap-2">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder="/Users/you/KilnDBData"
            spellCheck={false}
          />
          {pickerSupported && (
            <Button
              type="button"
              variant="secondary"
              onClick={pick}
              loading={picking}
              disabled={disabled}
            >
              <Icon name="folder_open" size={14} />
              Browse
            </Button>
          )}
        </div>
      </Field>

      {presets.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.path}
              type="button"
              onClick={() => onChange(p.path)}
              disabled={disabled}
              className="text-label px-2 py-1 rounded-md border border-border bg-bg-subtle hover:border-border-strong transition-colors disabled:opacity-50"
            >
              {p.label}
            </button>
          ))}
        </div>
      )}

      {pickerError && <p className="text-label text-danger">{pickerError}</p>}

      <ValidationStatus validating={validating} v={validation} />
    </div>
  );
}

function ValidationStatus({ validating, v }: { validating: boolean; v: PathValidationResponse | null }) {
  if (validating && !v) {
    return <p className="text-label text-text-subtle">Checking…</p>;
  }
  if (!v) return null;
  if (!v.ok) {
    return (
      <p className="text-label text-danger flex items-center gap-1.5">
        <Icon name="error" size={14} />
        {v.error ?? "Invalid path"}
      </p>
    );
  }
  return (
    <div className="text-label space-y-1">
      <p className="text-success flex items-center gap-1.5">
        <Icon name="check_circle" size={14} />
        <span className="font-mono">{v.resolvedPath}</span>
      </p>
      <dl className="grid grid-cols-3 gap-y-0.5 text-text-muted">
        <dt>State</dt>
        <dd className="col-span-2">
          {v.exists ? (v.isEmpty ? "Exists, empty" : "Exists, has files") : "Will be created"}
        </dd>
        <dt>Writable</dt>
        <dd className="col-span-2">{v.writable ? "Yes" : "No"}</dd>
        {v.freeBytes !== null && (
          <>
            <dt>Free space</dt>
            <dd className="col-span-2">{formatBytes(v.freeBytes)}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
