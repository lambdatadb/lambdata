import { useEffect, useRef, useState } from "react";
import { CircleAlert, CircleCheck, FolderOpen } from "lucide-react";
import type { PathValidationResponse, PickFolderResponse } from "@lambdata/shared";
import { api, ApiError, errorMessage } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { Button } from "../ui/Button";
import { DescriptionItem, DescriptionList } from "../ui/DescriptionList";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Spinner } from "../ui/Spinner";

interface Props {
  value: string;
  onChange: (path: string) => void;
  onValidation?: (v: PathValidationResponse | null) => void;
  onValidationUnavailable?: (unavailable: boolean) => void;
  onSetupTokenRejected?: (error: unknown) => void;
  presets?: { label: string; path: string }[];
  disabled?: boolean;
  pickerPrompt?: string;
  setupToken?: string;
}

function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

const SETUP_TOKEN_CODES = new Set(["setup_token_required", "setup_token_invalid"]);

export function isSetupTokenRefusal(error: unknown): boolean {
  if (!(error instanceof ApiError) || (error.status !== 403 && error.status !== 429)) return false;
  const code = (error.body as { code?: unknown } | null)?.code;
  return typeof code === "string" && SETUP_TOKEN_CODES.has(code);
}

export function validateDataDirPath(path: string, options: { setupToken?: string; signal?: AbortSignal } = {}): Promise<PathValidationResponse> {
  const token = options.setupToken?.trim();
  return api.post<PathValidationResponse>("/system/validate-path", token ? { path, setupToken: token } : { path }, { signal: options.signal });
}

export function DataDirPicker({
  value,
  onChange,
  onValidation,
  onValidationUnavailable,
  onSetupTokenRejected,
  presets = [],
  disabled,
  pickerPrompt,
  setupToken,
}: Props) {
  const [validating, setValidating] = useState(false);
  const [picking, setPicking] = useState(false);
  const [validation, setValidation] = useState<PathValidationResponse | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerSupported, setPickerSupported] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const onValidationRef = useRef(onValidation);
  onValidationRef.current = onValidation;
  const onUnavailableRef = useRef(onValidationUnavailable);
  onUnavailableRef.current = onValidationUnavailable;
  const onTokenRejectedRef = useRef(onSetupTokenRejected);
  onTokenRejectedRef.current = onSetupTokenRejected;

  useEffect(() => {
    const path = value.trim();
    setValidation(null);
    onValidationRef.current?.(null);
    if (!path || unavailable) {
      setValidating(false);
      return;
    }
    const controller = new AbortController();
    setValidating(true);
    const timer = setTimeout(async () => {
      try {
        const r = await validateDataDirPath(path, { setupToken, signal: controller.signal });
        if (controller.signal.aborted) return;
        setValidation(r);
        onValidationRef.current?.(r);
      } catch (e) {
        if (controller.signal.aborted) return;
        if (isSetupTokenRefusal(e) && onTokenRejectedRef.current) {
          onTokenRejectedRef.current(e);
          return;
        }
        if (isForbidden(e)) {
          setUnavailable(true);
          setPickerSupported(false);
          onUnavailableRef.current?.(true);
          return;
        }
        const r: PathValidationResponse = {
          ok: false,
          error: errorMessage(e, "Could not check this path"),
          resolvedPath: path,
          exists: false,
          writable: false,
          freeBytes: null,
          isEmpty: null,
        };
        setValidation(r);
        onValidationRef.current?.(r);
      } finally {
        if (!controller.signal.aborted) setValidating(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, unavailable, setupToken]);

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
      if (isForbidden(e)) setPickerSupported(false);
      else setPickerError(errorMessage(e, "The folder picker is not available"));
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="space-y-3">
      <Field label="Path" hint="Absolute path on the server. ~/ is expanded.">
        <div className="flex gap-2">
          <Input
            mono
            value={value}
            onChange={(e) => onChange(e.target.value)}
            disabled={disabled}
            placeholder="/mnt/user/appdata/lambdata"
            spellCheck={false}
            autoComplete="off"
          />
          {pickerSupported && (
            <Button variant="secondary" onClick={pick} loading={picking} disabled={disabled} className="shrink-0">
              <FolderOpen /> Browse
            </Button>
          )}
        </div>
      </Field>

      {presets.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-micro text-text-subtle">Suggestions</span>
          {presets.map((p) => (
            <Button
              key={p.path}
              size="xs"
              variant="outline"
              onClick={() => onChange(p.path)}
              disabled={disabled}
              aria-pressed={value === p.path}
              title={p.path}
            >
              {p.label}
            </Button>
          ))}
        </div>
      )}

      {pickerError && <p className="text-label text-danger">{pickerError}</p>}

      {unavailable ? (
        <p className="text-label text-text-muted">
          Paths can only be checked from the server itself before setup is complete. This one is checked when you continue.
        </p>
      ) : (
        <ValidationStatus validating={validating} v={validation} />
      )}
    </div>
  );
}

function ValidationStatus({ validating, v }: { validating: boolean; v: PathValidationResponse | null }) {
  if (validating) {
    return (
      <p className="flex items-center gap-2 text-label text-text-muted" role="status">
        <Spinner decorative size="xs" /> Checking the path…
      </p>
    );
  }
  if (!v) return null;
  if (!v.ok) {
    return (
      <p className="flex items-start gap-1.5 text-label text-danger" role="alert">
        <CircleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
        {v.error ?? "This path cannot be used"}
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-md border border-border bg-bg-inset px-3 py-2.5" aria-live="polite">
      <p className="flex items-center gap-1.5 text-label text-success">
        <CircleCheck aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 break-all font-mono">{v.resolvedPath}</span>
      </p>
      <DescriptionList className="text-label">
        <DescriptionItem term="State">{v.exists ? (v.isEmpty ? "Exists, empty" : "Exists, has files") : "Will be created"}</DescriptionItem>
        <DescriptionItem term="Writable">{v.writable ? "Yes" : "No"}</DescriptionItem>
        {v.freeBytes !== null && <DescriptionItem term="Free space">{formatBytes(v.freeBytes)}</DescriptionItem>}
      </DescriptionList>
    </div>
  );
}
