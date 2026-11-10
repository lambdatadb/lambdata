import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";
import type { NotificationCatalogResponse, NotificationEventInfo, NotificationEventType } from "@lambdata/shared";
import { Badge, Button, Checkbox, Collapsible, CollapsibleContent, CollapsibleTrigger, FieldError, cn } from "../ui";
import { focusRingInset } from "../ui/styles";
import { defaultEvents, eventsByGroup, routineNote } from "./model";

interface Props {
  catalog: NotificationCatalogResponse;
  value: NotificationEventType[];
  onChange: (next: NotificationEventType[]) => void;
  error?: string;
  initiallyOpen?: string[];
}

function sameSet(a: NotificationEventType[], b: NotificationEventType[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
}

export function EventPicker({ catalog, value, onChange, error, initiallyOpen = [] }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initiallyOpen));
  const groups = eventsByGroup(catalog);
  const selected = new Set(value);
  const defaults = defaultEvents(catalog);
  const order = catalog.events.map((e) => e.type);

  const setMany = (types: NotificationEventType[], on: boolean) => {
    const next = new Set(value);
    for (const t of types) {
      if (on) next.add(t);
      else next.delete(t);
    }
    onChange(order.filter((t) => next.has(t)));
  };

  const toggleOpen = (group: string, next: boolean) =>
    setOpen((prev) => {
      const copy = new Set(prev);
      if (next) copy.add(group);
      else copy.delete(group);
      return copy;
    });

  return (
    <div className="space-y-3" data-invalid={error ? "" : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-label text-text-muted">
          <span className="font-medium text-text">{value.length}</span> of {catalog.events.length} events
          {sameSet(value, defaults) && <span className="text-text-subtle"> · the defaults</span>}
        </p>
        <div className="-mr-2 flex flex-wrap gap-1">
          <Button variant="ghost" size="xs" disabled={sameSet(value, defaults)} onClick={() => onChange(defaults)}>
            Use defaults
          </Button>
          <Button variant="ghost" size="xs" disabled={value.length === order.length} onClick={() => onChange(order)}>
            Select all
          </Button>
        </div>
      </div>

      <p className="flex items-start gap-2 text-label text-text-muted">
        <Info aria-hidden className="mt-px size-3.5 shrink-0 text-text-subtle" />
        <span>
          Routine events are off by default because they can be noisy: a mirror that syncs every five minutes sends a message every five
          minutes.
        </span>
      </p>

      <ul className={cn("divide-y divide-border overflow-hidden rounded-lg border", error ? "border-danger/50" : "border-border")}>
        {groups.map((group) => (
          <EventGroup
            key={group.group}
            label={group.label}
            events={group.events}
            selected={selected}
            open={open.has(group.group)}
            onOpenChange={(next) => toggleOpen(group.group, next)}
            onSet={setMany}
          />
        ))}
      </ul>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

interface GroupProps {
  label: string;
  events: NotificationEventInfo[];
  selected: Set<NotificationEventType>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSet: (types: NotificationEventType[], on: boolean) => void;
}

function EventGroup({ label, events, selected, open, onOpenChange, onSet }: GroupProps) {
  const chosen = events.filter((e) => selected.has(e.type));
  const state = chosen.length === 0 ? false : chosen.length === events.length ? true : "indeterminate";
  const routine = events.filter((e) => !e.defaultOn).length;
  return (
    <li data-event-group={label}>
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="flex items-start gap-3 px-3.5 py-3">
          <Checkbox
            checked={state}
            onCheckedChange={(next) => onSet(events.map((e) => e.type), next === true)}
            aria-label={`All ${label} events`}
            className="mt-0.5"
          />
          <CollapsibleTrigger className={cn("-my-1 flex min-w-0 flex-1 items-start gap-3 rounded-md py-1 text-left", focusRingInset)}>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-body font-medium text-text">{label}</span>
                <span className="font-mono text-micro text-text-subtle">
                  {chosen.length}/{events.length}
                </span>
                {routine > 0 && <span className="text-micro text-text-subtle">{routine === 1 ? "1 routine" : `${routine} routine`}</span>}
              </span>
              <span className="mt-0.5 block truncate text-label text-text-muted">
                {chosen.length > 0 ? chosen.map((e) => e.label).join(" · ") : "None"}
              </span>
            </span>
            <ChevronDown aria-hidden className={cn("mt-0.5 size-4 shrink-0 text-text-subtle transition-transform", open && "rotate-180")} />
            <span className="sr-only">{open ? "Hide" : "Show"} the events</span>
          </CollapsibleTrigger>
        </div>
        <CollapsibleContent>
          <ul className="space-y-3 border-t border-border bg-bg-inset/50 py-3 pl-10 pr-3.5">
            {events.map((e) => {
              const note = routineNote(e);
              return (
                <li key={e.type}>
                  <Checkbox
                    checked={selected.has(e.type)}
                    onCheckedChange={(next) => onSet([e.type], next === true)}
                    label={
                      <span className="inline-flex flex-wrap items-center gap-1.5">
                        {e.label}
                        {note && (
                          <Badge variant="muted" size="sm">
                            routine
                          </Badge>
                        )}
                      </span>
                    }
                    description={
                      <>
                        {e.description}
                        {note && <span className="mt-0.5 block text-text-subtle">{note}</span>}
                      </>
                    }
                  />
                </li>
              );
            })}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}
