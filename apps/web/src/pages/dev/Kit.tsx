import {
  ArrowLeftRight,
  Bell,
  Braces,
  ChevronRight,
  Copy,
  Database,
  Download,
  Ellipsis,
  FileUp,
  GitBranch,
  GitCommitHorizontal,
  HardDrive,
  History,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Network,
  Pencil,
  Play,
  Plus,
  RadioTower,
  RotateCcw,
  Search,
  Settings,
  Table2,
  Trash2,
  Upload,
  User,
  Users,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ColorTheme } from "@lambdata/shared";
import { COLOR_THEMES, DEFAULT_COLOR_THEME } from "../../lib/theme";
import { OperationStates } from "./OperationStates";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  Avatar,
  Badge,
  BrandMark,
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  CodeBlock,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
  ConfirmDialog,
  CopyButton,
  CopyableField,
  DescriptionList,
  Dialog,
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  EmptyState,
  Field,
  FieldGroup,
  FileDropzone,
  Input,
  Kbd,
  KbdGroup,
  ListInput,
  Logo,
  NativeSelect,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Progress,
  RadioCard,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  SectionLabel,
  SegmentedControl,
  SelectMenu,
  Separator,
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  SimpleTooltip,
  Skeleton,
  SkeletonRows,
  Spinner,
  StatTile,
  StatusDot,
  Switch,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Table,
  TableEmpty,
  TableSkeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  ThemeSwatches,
  Wordmark,
  cn,
  useToast,
} from "../../components/ui";

const SECTIONS = [
  ["identity", "Identity"],
  ["colour", "Colour"],
  ["type", "Typography"],
  ["buttons", "Buttons"],
  ["badges", "Badges and status"],
  ["forms", "Form controls"],
  ["choices", "Choices"],
  ["cards", "Cards and stats"],
  ["table", "Table"],
  ["tabs", "Tabs"],
  ["feedback", "Feedback"],
  ["overlays", "Overlays"],
  ["menus", "Menus and popovers"],
  ["data", "Data display"],
  ["disclosure", "Disclosure"],
  ["dropzone", "File dropzone"],
  ["operations", "Operation states"],
  ["narrow", "Narrow layouts"],
] as const;

function channelsToHex(channels: string): string {
  const parts = channels.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return "";
  return `#${parts
    .slice(0, 3)
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`.toUpperCase();
}

function luminance(channels: string): number {
  const [r = 0, g = 0, b = 0] = channels.trim().split(/\s+/).map(Number);
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function useTokens(theme: ColorTheme): Record<string, string> {
  const [tokens, setTokens] = useState<Record<string, string>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const names = [
      "surface-base",
      "surface-inset",
      "surface-panel",
      "surface-raised",
      "surface-overlay",
      "surface-hover",
      "surface-selected",
      "edge",
      "edge-strong",
      "edge-input",
      "edge-control",
      "content-1",
      "content-2",
      "content-3",
      "accent",
      "accent-fg",
      "ring",
      "ok",
      "warn",
      "danger",
      "danger-fg",
      "info",
      "chart-1",
      "chart-2",
      "chart-3",
      "chart-4",
      "chart-5",
      "chart-6",
      "chart-other",
    ];
    const next: Record<string, string> = {};
    for (const name of names) next[name] = style.getPropertyValue(`--${name}`).trim();
    setTokens(next);
  }, [theme]);
  return tokens;
}

function Section({ id, title, description, children }: { id: string; title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section id={`kit-${id}`} aria-labelledby={`kit-${id}-title`} className="scroll-mt-20 space-y-5 border-t border-border pt-10 first:border-t-0 first:pt-0">
      <header className="space-y-1">
        <h2 id={`kit-${id}-title`} className="text-title font-semibold text-text">
          {title}
        </h2>
        {description && <p className="max-w-3xl text-body text-text-muted">{description}</p>}
      </header>
      {children}
    </section>
  );
}

function Surfaces({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      {(["base", "panel"] as const).map((surface) => (
        <div
          key={surface}
          className={cn(
            "min-w-0 rounded-lg border border-border p-5",
            surface === "base" ? "bg-bg" : "bg-bg-panel",
            className,
          )}
        >
          <div className="mb-4 font-mono text-micro text-text-subtle">{surface === "base" ? "on bg-bg" : "on bg-bg-panel"}</div>
          {children}
        </div>
      ))}
    </div>
  );
}

function Frame({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div className={cn("min-w-0 rounded-lg border border-border bg-bg p-5", className)}>
      {label && <div className="mb-4 font-mono text-micro text-text-subtle">{label}</div>}
      {children}
    </div>
  );
}

function Row({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="grid gap-2 py-2 sm:grid-cols-[9rem_1fr] sm:items-center">
      <div className="text-label text-text-subtle">{label}</div>
      <div className={cn("flex min-w-0 flex-wrap items-center gap-2", className)}>{children}</div>
    </div>
  );
}

function Swatch({ name, token, channels, against }: { name: string; token: string; channels?: string; against?: [string, string][] }) {
  return (
    <div className="min-w-0 overflow-hidden rounded-md border border-border">
      <div className="h-12 border-b border-border" style={{ backgroundColor: channels ? `rgb(${channels})` : undefined }} />
      <div className="space-y-0.5 bg-bg-panel px-2.5 py-2">
        <div className="truncate text-label font-medium text-text">{name}</div>
        <div className="truncate font-mono text-micro text-text-subtle">{token}</div>
        <div className="font-mono text-micro text-text-muted">{channels ? channelsToHex(channels) : "…"}</div>
        {against?.map(([label, other]) => (
          <div key={label} className="font-mono text-micro text-text-subtle">
            {label} {channels && other ? ratio(channels, other).toFixed(2) : "…"}
          </div>
        ))}
      </div>
    </div>
  );
}

const DB_ROWS = [
  { name: "Orders Analytics", schema: "orders_analytics", kind: "standard", size: "52.5 MB", tables: 14, head: "a41f9c2", status: "up" },
  { name: "Metrics Mirror", schema: "metrics_mirror", kind: "mirror", size: "30.2 MB", tables: 3, head: "7d03e1b", status: "syncing" },
  { name: "Customer Portal", schema: "customer_portal", kind: "standard", size: "118 MB", tables: 41, head: "c90b5d4", status: "up" },
  { name: "Legacy Billing", schema: "legacy_billing", kind: "standard", size: "2.1 GB", tables: 212, head: "f12aa07", status: "failing" },
];

const SAMPLE_SQL = `SELECT o.id, o.total_cents, c.email
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.created_at >= NOW() - INTERVAL 7 DAY
  AND o.status IN ('paid', 'refunded')
ORDER BY o.created_at DESC
LIMIT 50; -- this is an intentionally long line to show how wrapping behaves inside the code block`;

export function KitPage() {
  const toast = useToast();
  const [theme, setTheme] = useState<ColorTheme>(() => {
    const current = document.documentElement.dataset.theme as ColorTheme | undefined;
    return current ?? DEFAULT_COLOR_THEME;
  });
  const tokens = useTokens(theme);

  useEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.theme;
    return () => {
      if (previous) root.dataset.theme = previous;
    };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [tallOpen, setTallOpen] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dangerOpen, setDangerOpen] = useState(false);
  const [dangerLoading, setDangerLoading] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [dbType, setDbType] = useState("standard");
  const [range, setRange] = useState("5d");
  const [plan, setPlan] = useState("daily");
  const [region, setRegion] = useState("eu-west");
  const [nativeRole, setNativeRole] = useState("viewer");
  const [tailnet, setTailnet] = useState(true);
  const [vitals, setVitals] = useState(false);
  const [checked, setChecked] = useState(true);
  const [tab, setTab] = useState("overview");
  const [origins, setOrigins] = useState<string[]>(["https://db.example.com"]);
  const [files, setFiles] = useState<File[]>([]);
  const [showColumns, setShowColumns] = useState({ size: true, tables: true });
  const [sort, setSort] = useState("name");
  const [progress, setProgress] = useState(42);

  useEffect(() => {
    const id = window.setInterval(() => setProgress((p) => (p >= 100 ? 8 : p + 7)), 1200);
    return () => window.clearInterval(id);
  }, []);

  const base = tokens["surface-base"] ?? "";
  const panel = tokens["surface-panel"] ?? "";
  const accent = tokens["accent"] ?? "";

  const swatchesSurface = useMemo(
    () => [
      ["Base", "bg-bg", "surface-base"],
      ["Inset", "bg-bg-inset", "surface-inset"],
      ["Panel", "bg-bg-panel", "surface-panel"],
      ["Raised", "bg-bg-raised / bg-bg-subtle", "surface-raised"],
      ["Overlay", "bg-bg-overlay", "surface-overlay"],
      ["Hover", "bg-bg-hover", "surface-hover"],
      ["Selected", "bg-bg-selected", "surface-selected"],
    ],
    [],
  );

  return (
    <div className="min-h-dvh bg-bg text-text">
      <header className="sticky top-0 z-30 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-[90rem] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-3">
            <BrandMark size="md" />
            <Separator orientation="vertical" className="h-5" />
            <span className="text-body text-text-muted">Component kit</span>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="hidden text-label text-text-subtle sm:inline">Theme</span>
            <div className="max-w-full overflow-x-auto">
              <SegmentedControl
                aria-label="Theme"
                size="xs"
                value={theme}
                onValueChange={(v) => setTheme(v as ColorTheme)}
                options={COLOR_THEMES.map((t) => ({ value: t.value, label: t.label }))}
              />
            </div>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-[90rem] gap-10 px-4 py-8 sm:px-6 lg:grid-cols-[12rem_1fr]">
        <nav aria-label="Kit sections" className="hidden lg:block">
          <ul className="sticky top-20 space-y-0.5">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#kit-${id}`}
                  className="block rounded-md px-2.5 py-1.5 text-body text-text-muted transition-colors hover:bg-bg-hover hover:text-text focus-ring"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 space-y-10">
          <Section
            id="identity"
            title="Identity"
            description="The mark is a lambda drawn as a commit graph: three commits and a filled HEAD where the branch leaves the trunk. The glyph follows currentColor and defaults to the theme accent; the tile variant is for favicons and app icons."
          >
            <Surfaces>
              <div className="space-y-5">
                <Row label="Logo glyph">
                  {[14, 16, 20, 24, 32, 48].map((s) => (
                    <Logo key={s} size={s} />
                  ))}
                </Row>
                <Row label="Logo tile">
                  {[16, 24, 32, 48, 64].map((s) => (
                    <Logo key={s} size={s} tile />
                  ))}
                </Row>
                <Row label="Glyph in text colour">
                  <Logo size={24} className="text-text" />
                  <Logo size={24} className="text-text-muted" />
                </Row>
                <Row label="Wordmark">
                  <Wordmark size="sm" />
                  <Wordmark size="md" />
                  <Wordmark size="lg" />
                  <Wordmark size="xl" />
                </Row>
                <Row label="Lockup">
                  <BrandMark size="sm" />
                  <BrandMark size="md" />
                  <BrandMark size="lg" tile />
                </Row>
                <Row label="Static assets">
                  <img src="/favicon.svg" alt="favicon.svg" width={32} height={32} />
                  <img src="/lambdata-mark.svg" alt="lambdata-mark.svg" width={32} height={32} />
                  <img src="/lambdata-mark.png" alt="lambdata-mark.png" width={48} height={48} />
                  <span className="font-mono text-micro text-text-subtle">favicon.svg · lambdata-mark.svg · lambdata-mark.png</span>
                </Row>
              </div>
            </Surfaces>
          </Section>

          <Section
            id="colour"
            title="Colour"
            description="Tokens are RGB channels on :root, mapped to Tailwind names. Ratios are computed live from the active theme (WCAG 2.x). Lime is for the primary action, focus, the active item and HEAD; everything else is ink, slate and text."
          >
            <div className="space-y-6">
              <div>
                <SectionLabel>Surfaces</SectionLabel>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
                  {swatchesSurface.map(([name, cls, token]) => (
                    <Swatch key={token} name={name!} token={cls!} channels={tokens[token!]} />
                  ))}
                </div>
              </div>
              <div>
                <SectionLabel>Borders</SectionLabel>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Swatch name="Hairline" token="border-border" channels={tokens["edge"]} against={[["on panel", panel]]} />
                  <Swatch name="Strong" token="border-border-strong" channels={tokens["edge-strong"]} against={[["on panel", panel]]} />
                  <Swatch name="Input" token="border-border-input" channels={tokens["edge-input"]} against={[["on panel", panel]]} />
                  <Swatch name="Control" token="border-border-control" channels={tokens["edge-control"]} against={[["on panel", panel]]} />
                </div>
              </div>
              <div>
                <SectionLabel>Text</SectionLabel>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Swatch name="Text" token="text-text" channels={tokens["content-1"]} against={[["on base", base], ["on panel", panel]]} />
                  <Swatch name="Muted" token="text-text-muted" channels={tokens["content-2"]} against={[["on base", base], ["on panel", panel], ["on selected", tokens["surface-selected"] ?? ""]]} />
                  <Swatch name="Subtle" token="text-text-subtle" channels={tokens["content-3"]} against={[["on base", base], ["on panel", panel], ["on hover", tokens["surface-hover"] ?? ""]]} />
                  <Swatch name="Accent fg" token="text-accent-fg" channels={tokens["accent-fg"]} against={[["on accent", accent]]} />
                </div>
              </div>
              <div>
                <SectionLabel>Signal</SectionLabel>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                  <Swatch name="Accent" token="accent" channels={tokens["accent"]} against={[["on panel", panel]]} />
                  <Swatch name="Success" token="success" channels={tokens["ok"]} against={[["on panel", panel]]} />
                  <Swatch name="Warn" token="warn" channels={tokens["warn"]} against={[["on panel", panel]]} />
                  <Swatch name="Danger" token="danger" channels={tokens["danger"]} against={[["on panel", panel], ["fg on fill", tokens["danger-fg"] ?? ""]]} />
                  <Swatch name="Info" token="info" channels={tokens["info"]} against={[["on panel", panel]]} />
                </div>
              </div>
              <div>
                <SectionLabel>Chart ramp</SectionLabel>
                <Frame>
                  <div className="flex flex-wrap gap-2">
                    {["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6", "chart-other"].map((name) => (
                      <div key={name} className="flex items-center gap-2 rounded-md border border-border bg-bg-panel px-2.5 py-1.5">
                        <span className="size-3 rounded-sm" style={{ backgroundColor: `rgb(var(--${name}))` }} />
                        <span className="font-mono text-micro text-text-muted">{name}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex h-24 items-end gap-1.5" aria-hidden>
                    {Array.from({ length: 28 }, (_, i) => {
                      const stack = [0.3, 0.22, 0.18, 0.14, 0.1, 0.06].map((w, k) => w * (0.6 + ((i * (k + 3)) % 7) / 10));
                      const total = stack.reduce((a, b) => a + b, 0);
                      const height = 55 + ((i * 7) % 45);
                      return (
                        <div key={i} className="flex flex-1 flex-col-reverse gap-px overflow-hidden rounded-[3px]" style={{ height: `${height}%` }}>
                          {stack.map((h, k) => (
                            <div key={k} style={{ flexBasis: `${(h / total) * 100}%`, backgroundColor: `rgb(var(--chart-${k + 1}))` }} />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </Frame>
              </div>
            </div>
          </Section>

          <Section id="type" title="Typography" description="Inter for interface text, JetBrains Mono for data, hashes, identifiers and the wordmark. Use the named scale; text-sm and text-xs now equal body and label.">
            <Surfaces>
              <div className="space-y-3">
                <div className="text-display font-semibold">Display 26 / 32</div>
                <div className="text-title font-semibold">Title 18 / 26</div>
                <div className="font-mono text-metric font-medium tracking-[-0.04em]">1,284.6 MB</div>
                <div className="text-heading font-semibold">Heading 15 / 22 · card titles</div>
                <div className="text-body">Body 13 / 20 · the default for interface copy and table cells.</div>
                <div className="font-mono text-code">Code 12.5 / 20 · orders_analytics · a41f9c2 · 10.0.0.5:3307</div>
                <div className="text-label text-text-muted">Label 12 / 16 · field labels and table headers</div>
                <div className="text-micro text-text-subtle">Micro 11 / 16 · hints, timestamps, captions</div>
                <Separator />
                <div className="space-y-1 font-mono text-micro text-text-muted">
                  <div>
                    cn(&quot;text-label&quot;, &quot;text-text-muted&quot;) → <span className="text-text">{cn("text-label", "text-text-muted")}</span>
                  </div>
                  <div>
                    cn(&quot;p-5&quot;, &quot;p-0&quot;) → <span className="text-text">{cn("p-5", "p-0")}</span>
                  </div>
                </div>
              </div>
            </Surfaces>
          </Section>

          <Section id="buttons" title="Buttons" description="Primary is the only filled lime control; use one per view. Buttons default to type=button. Icon-only buttons need aria-label and get a tooltip.">
            <Surfaces>
              <div className="divide-y divide-border">
                <Row label="Variants">
                  <Button>
                    <Plus /> New database
                  </Button>
                  <Button variant="secondary">Secondary</Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button variant="danger">Delete</Button>
                  <Button variant="danger-soft">Danger soft</Button>
                  <Button variant="link">Link</Button>
                </Row>
                <Row label="Sizes">
                  <Button size="xs" variant="secondary">
                    Extra small
                  </Button>
                  <Button size="sm" variant="secondary">
                    Small
                  </Button>
                  <Button size="md" variant="secondary">
                    Medium
                  </Button>
                  <Button size="lg" variant="secondary">
                    Large
                  </Button>
                  <Button size="sm">Primary small</Button>
                </Row>
                <Row label="Icon only">
                  <SimpleTooltip content="Take checkpoint">
                    <Button size="icon" variant="secondary" aria-label="Take checkpoint">
                      <GitCommitHorizontal />
                    </Button>
                  </SimpleTooltip>
                  <SimpleTooltip content="Settings">
                    <Button size="icon-sm" variant="ghost" aria-label="Settings">
                      <Settings />
                    </Button>
                  </SimpleTooltip>
                  <SimpleTooltip content="Delete object">
                    <Button size="icon-xs" variant="ghost" aria-label="Delete object">
                      <Trash2 />
                    </Button>
                  </SimpleTooltip>
                  <SimpleTooltip content="New">
                    <Button size="icon-sm" aria-label="New">
                      <Plus />
                    </Button>
                  </SimpleTooltip>
                </Row>
                <Row label="States">
                  <Button loading>Provisioning</Button>
                  <Button variant="secondary" loading>
                    Saving
                  </Button>
                  <Button disabled>Disabled</Button>
                  <Button variant="secondary" disabled>
                    Disabled
                  </Button>
                  <Button size="icon-sm" variant="secondary" loading aria-label="Refreshing">
                    <RotateCcw />
                  </Button>
                </Row>
                <Row label="As link">
                  <Button asChild variant="outline" size="sm">
                    <a href="#kit-buttons">
                      Open docs <ChevronRight />
                    </a>
                  </Button>
                </Row>
              </div>
            </Surfaces>
          </Section>

          <Section id="badges" title="Badges and status" description="Badges carry state with a word, not colour alone. Mono badges are for hashes and identifiers; the accent badge is reserved for HEAD and similar singular markers.">
            <Surfaces>
              <div className="divide-y divide-border">
                <Row label="Variants">
                  <Badge>default</Badge>
                  <Badge variant="muted">muted</Badge>
                  <Badge variant="outline">outline</Badge>
                  <Badge variant="accent">accent</Badge>
                  <Badge variant="success">success</Badge>
                  <Badge variant="warn">warn</Badge>
                  <Badge variant="danger">danger</Badge>
                  <Badge variant="info">info</Badge>
                  <Badge variant="solid">solid</Badge>
                </Row>
                <Row label="With dot">
                  <Badge variant="success" dot>
                    running
                  </Badge>
                  <Badge variant="warn" dot>
                    syncing
                  </Badge>
                  <Badge variant="danger" dot>
                    failing
                  </Badge>
                  <Badge variant="muted" dot>
                    stopped
                  </Badge>
                </Row>
                <Row label="Mono and sizes">
                  <Badge variant="accent" mono size="sm">
                    HEAD
                  </Badge>
                  <Badge mono size="sm">
                    a41f9c2
                  </Badge>
                  <Badge mono>v10.11.6</Badge>
                  <Badge size="lg" variant="outline">
                    <GitBranch /> main
                  </Badge>
                  <Badge tone="success">tone= still works</Badge>
                </Row>
                <Row label="Status dot">
                  <span className="inline-flex items-center gap-2 text-label text-text-muted">
                    <StatusDot tone="success" pulse /> mariadb up
                  </span>
                  <span className="inline-flex items-center gap-2 text-label text-text-muted">
                    <StatusDot tone="warn" /> tailnet degraded
                  </span>
                  <span className="inline-flex items-center gap-2 text-label text-text-muted">
                    <StatusDot tone="danger" /> tunnel down
                  </span>
                  <span className="inline-flex items-center gap-2 text-label text-text-muted">
                    <StatusDot tone="muted" /> off
                  </span>
                </Row>
                <Row label="Kbd">
                  <KbdGroup>
                    <Kbd>⌘</Kbd>
                    <Kbd>K</Kbd>
                  </KbdGroup>
                  <Kbd>/</Kbd>
                  <Kbd>Esc</Kbd>
                  <span className="text-label text-text-muted">
                    Press <Kbd>Enter</Kbd> to run
                  </span>
                </Row>
              </div>
            </Surfaces>
          </Section>

          <Section id="forms" title="Form controls" description="Field wires the label, hint and error to the control by id, aria-describedby and aria-invalid. Kit controls inside a Field pick these up automatically.">
            <Surfaces>
              <div className="space-y-5">
                <FieldGroup>
                  <Field label="Display name" required hint="Shown in the console only">
                    <Input placeholder="Customer Portal" />
                  </Field>
                  <Field label="Schema" hint="Lowercase, digits and underscores">
                    <Input mono defaultValue="customer_portal" />
                  </Field>
                  <Field label="Allowed hosts" error="Use % for any host, or a pattern such as 192.168.%">
                    <Input mono defaultValue="192.168.1.*" />
                  </Field>
                  <Field label="Search" labelAction={<a className="hover:text-text" href="#kit-forms">Syntax</a>}>
                    <Input leading={<Search />} placeholder="Databases, pages, actions" trailing={<Kbd>/</Kbd>} />
                  </Field>
                  <Field label="Disabled">
                    <Input disabled defaultValue="read-only replica" />
                  </Field>
                  <Field label="Small input">
                    <Input inputSize="sm" placeholder="h-8" />
                  </Field>
                </FieldGroup>
                <FieldGroup>
                  <Field label="Role (native select)" hint="NativeSelect">
                    <NativeSelect value={nativeRole} onChange={(e) => setNativeRole(e.target.value)}>
                      <option value="admin">Admin</option>
                      <option value="db_owner">DB owner</option>
                      <option value="viewer">Viewer</option>
                    </NativeSelect>
                  </Field>
                  <Field label="Region (Radix select)" hint="SelectMenu with options">
                    <SelectMenu
                      value={region}
                      onValueChange={setRegion}
                      options={[
                        { value: "eu-west", label: "eu-west", description: "Amsterdam" },
                        { value: "us-east", label: "us-east", description: "Virginia" },
                        { value: "ap-south", label: "ap-south", description: "Mumbai" },
                        { value: "local", label: "local", description: "This host", disabled: true },
                      ]}
                    />
                  </Field>
                  <Field label="Placeholder select">
                    <SelectMenu placeholder="Pick a source" options={[{ value: "mysql", label: "MySQL / MariaDB" }, { value: "postgres", label: "PostgreSQL" }]} />
                  </Field>
                  <Field label="Narrow native select">
                    <NativeSelect className="w-32" selectSize="sm" defaultValue="24h">
                      <option value="24h">Last 24h</option>
                      <option value="7d">Last 7 days</option>
                    </NativeSelect>
                  </Field>
                </FieldGroup>
                <Field label="Public URLs" hint="ListInput: type a value and press Enter or Add. Values are de-duplicated and can be validated.">
                  <ListInput
                    values={origins}
                    onChange={setOrigins}
                    placeholder="https://db.example.com"
                    addLabel="Add URL"
                    emptyText="None yet."
                    validate={(v) => (/^https?:\/\//.test(v) ? null : "Start with http:// or https://.")}
                  />
                </Field>
                <Field label="Query" hint="Textarea defaults to mono; pass mono={false} for prose">
                  <Textarea rows={3} defaultValue={"SELECT COUNT(*) FROM orders\nWHERE status = 'paid';"} />
                </Field>
                <Field label="Notes">
                  <Textarea mono={false} rows={2} placeholder="Why this checkpoint exists" />
                </Field>
              </div>
            </Surfaces>
          </Section>

          <Section id="choices" title="Choices" description="Checkbox, radio, choice cards, segmented control and switch. All are Radix primitives with arrow-key navigation where it applies.">
            <Surfaces>
              <div className="space-y-6">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-3">
                    <Checkbox label="Include data" description="Copy rows as well as schema" checked={checked} onCheckedChange={(v) => setChecked(v === true)} />
                    <Checkbox label="Indeterminate" checked="indeterminate" />
                    <Checkbox label="Disabled" disabled />
                    <div className="flex items-center gap-3">
                      <Checkbox aria-label="Bare checkbox" defaultChecked />
                      <Checkbox aria-label="Bare unchecked" />
                    </div>
                  </div>
                  <RadioGroup value={plan} onValueChange={setPlan} aria-label="Checkpoint schedule">
                    <RadioGroupItem value="hourly" label="Hourly" description="Keeps 48 checkpoints" />
                    <RadioGroupItem value="daily" label="Daily" description="Keeps 30 checkpoints" />
                    <RadioGroupItem value="manual" label="Manual only" disabled />
                  </RadioGroup>
                </div>
                <RadioGroup value={dbType} onValueChange={setDbType} aria-label="Database type" className="grid gap-2.5 sm:grid-cols-3">
                  <RadioCard value="standard" icon={<Database />} title="Standard" description="A fresh, empty schema" />
                  <RadioCard value="mirror" icon={<ArrowLeftRight />} title="Mirror" description="Syncs from an external source" />
                  <RadioCard
                    value="import"
                    icon={<FileUp />}
                    title="Import"
                    description="Load from a dump file"
                    badge={
                      <Badge size="sm" variant="muted">
                        soon
                      </Badge>
                    }
                    disabled
                  />
                </RadioGroup>
                <div className="flex flex-wrap items-center gap-4">
                  <SegmentedControl
                    aria-label="Range"
                    value={range}
                    onValueChange={setRange}
                    options={[
                      { value: "1d", label: "1D" },
                      { value: "5d", label: "5D" },
                      { value: "15d", label: "15D" },
                      { value: "30d", label: "30D" },
                    ]}
                  />
                  <SegmentedControl
                    aria-label="View"
                    size="md"
                    defaultValue="grid"
                    options={[
                      { value: "grid", label: <><LayoutDashboard /> Grid</> },
                      { value: "list", label: <><Table2 /> List</> },
                    ]}
                  />
                  <SegmentedControl aria-label="Disabled option" size="xs" defaultValue="a" options={[{ value: "a", label: "On" }, { value: "b", label: "Off", disabled: true }]} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Switch checked={tailnet} onChange={setTailnet} label="Tailnet only" description="Restrict connections to your Tailscale network" />
                  <Switch checked={vitals} onChange={setVitals} side="right" label="Show in dashboard vitals" description="Switch on the right, label first" />
                  <Switch checked disabled label="Disabled on" />
                  <div className="flex items-center gap-3">
                    <Switch aria-label="Small switch" size="sm" defaultChecked />
                    <Switch aria-label="Small switch off" size="sm" />
                    <Switch aria-label="Bare switch" />
                  </div>
                </div>
              </div>
            </Surfaces>
          </Section>

          <Section id="cards" title="Cards and stats" description="Cards are flat: a hairline border, no shadow. Padded cards (default) take children directly; flush cards are built from CardHeader, CardContent and CardFooter, which own their spacing.">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile label="Databases" value={4} icon={Database} hint="3 standard · 1 mirror" />
              <StatTile label="Storage" value={212_000_000} format={(n) => `${(n / 1e6).toFixed(1)} MB`} icon={HardDrive} hint="2 buckets · 31 objects" />
              <StatTile label="Checkpoints (24h)" value={null} icon={History} hint="none yet" />
              <StatTile label="Realtime" value={0} icon={RadioTower} loading hint="loading" />
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <Card>
                <CardHeader title="Connection" description="Padded card with a header action" action={<Button size="sm" variant="secondary"><Copy /> Copy URL</Button>} />
                <DescriptionList
                  items={[
                    { term: "Host", value: "10.0.0.5", mono: true },
                    { term: "Port", value: "3307", mono: true },
                    { term: "User", value: "ld_customer_portal", mono: true },
                    { term: "Created", value: "9 Nov 2026, 16:42" },
                  ]}
                />
              </Card>
              <Card flush>
                <CardHeader divided title="Checkpoints" description="Flush card, divided header" action={<Button size="sm"><GitCommitHorizontal /> Checkpoint</Button>} />
                <CardContent className="space-y-3">
                  {[
                    ["c90b5d4", "Before price migration", "2m ago", true],
                    ["7d03e1b", "Nightly", "6h ago", false],
                    ["a41f9c2", "Nightly", "1d ago", false],
                  ].map(([hash, message, when, head]) => (
                    <div key={hash as string} className="flex items-center gap-3">
                      <span className={cn("size-2.5 shrink-0 rounded-full border-2", head ? "border-accent bg-accent" : "border-border-control")} />
                      <span className="font-mono text-code text-text-muted">{hash}</span>
                      <span className="min-w-0 flex-1 truncate text-body">{message}</span>
                      {head && (
                        <Badge variant="accent" mono size="sm">
                          HEAD
                        </Badge>
                      )}
                      <span className="text-micro text-text-subtle">{when}</span>
                    </div>
                  ))}
                </CardContent>
                <CardFooter>
                  <Button variant="ghost" size="sm">
                    View history
                  </Button>
                </CardFooter>
              </Card>
              <Card interactive>
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1">
                    <CardTitle>
                      <a href="#kit-cards" className="stretched-link rounded-sm outline-none focus-visible:underline">
                        Customer Portal
                      </a>
                    </CardTitle>
                    <CardDescription className="font-mono text-code">customer_portal</CardDescription>
                  </div>
                  <Badge variant="success" dot>
                    up
                  </Badge>
                </div>
                <div className="mt-4 flex gap-4 text-label text-text-muted">
                  <span>118 MB</span>
                  <span>41 tables</span>
                </div>
              </Card>
              <Card variant="inset">
                <CardTitle>Inset card</CardTitle>
                <CardDescription className="mt-1">variant=&quot;inset&quot; for wells and nested groups.</CardDescription>
                <DescriptionList layout="grid" className="mt-4" items={[{ term: "Engine", value: "MariaDB 11.4" }, { term: "Data dir", value: "/mnt/user/appdata", mono: true }]} />
              </Card>
            </div>
          </Section>

          <Section id="table" title="Table" description="Headers are scope=col; numeric cells are mono and right-aligned. Make a row clickable with a real link and the stretched-link class, never an onClick row.">
            <Table caption="Databases">
              <THead>
                <TR>
                  <TH>Name</TH>
                  <TH>Kind</TH>
                  <TH>HEAD</TH>
                  {showColumns.size && <TH numeric>Size</TH>}
                  {showColumns.tables && <TH numeric>Tables</TH>}
                  <TH className="w-12">
                    <span className="sr-only">Actions</span>
                  </TH>
                </TR>
              </THead>
              <TBody>
                {DB_ROWS.map((row, i) => (
                  <TR key={row.schema} interactive selected={i === 2}>
                    <TD>
                      <a href={`#kit-table`} className="stretched-link font-medium text-text outline-none focus-visible:underline">
                        {row.name}
                      </a>
                      <div className="font-mono text-micro text-text-subtle">{row.schema}</div>
                    </TD>
                    <TD>
                      <Badge variant={row.kind === "mirror" ? "info" : "default"}>{row.kind}</Badge>
                    </TD>
                    <TD mono className="text-text-muted">
                      {row.head}
                    </TD>
                    {showColumns.size && <TD numeric>{row.size}</TD>}
                    {showColumns.tables && <TD numeric>{row.tables}</TD>}
                    <TD className="relative z-10">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon-xs" aria-label={`Actions for ${row.name}`}>
                            <Ellipsis />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem>
                            <GitCommitHorizontal /> Take checkpoint
                          </DropdownMenuItem>
                          <DropdownMenuItem>
                            <Download /> Export dump
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem variant="danger">
                            <Trash2 /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
            <div className="grid gap-3 lg:grid-cols-2">
              <Table caption="Empty table">
                <THead>
                  <TR>
                    <TH>Bucket</TH>
                    <TH numeric>Objects</TH>
                  </TR>
                </THead>
                <TBody>
                  <TableEmpty colSpan={2}>No buckets yet</TableEmpty>
                </TBody>
              </Table>
              <Table caption="Loading table">
                <THead>
                  <TR>
                    <TH>Function</TH>
                    <TH>Runtime</TH>
                    <TH numeric>Last run</TH>
                  </TR>
                </THead>
                <TBody>
                  <TableSkeleton rows={3} cols={3} />
                </TBody>
              </Table>
            </div>
          </Section>

          <Section id="tabs" title="Tabs" description="Underline tabs for page sections (the active tab gets the lime rule); pill tabs for local switches. The list scrolls horizontally on narrow screens.">
            <Surfaces>
              <div className="space-y-6">
                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList aria-label="Database sections">
                    <TabsTrigger value="overview">Overview</TabsTrigger>
                    <TabsTrigger value="query">Query</TabsTrigger>
                    <TabsTrigger value="tables" count={14}>
                      Tables
                    </TabsTrigger>
                    <TabsTrigger value="history" icon={<History />}>
                      History
                    </TabsTrigger>
                    <TabsTrigger value="import">Import</TabsTrigger>
                    <TabsTrigger value="metrics">Metrics</TabsTrigger>
                    <TabsTrigger value="danger" disabled>
                      Danger
                    </TabsTrigger>
                  </TabsList>
                  <TabsContent value={tab} className="text-body text-text-muted">
                    Route-driven tabs render each TabsTrigger asChild around a Link, so they can be opened in a new tab.
                  </TabsContent>
                </Tabs>
                <Tabs defaultValue="curl">
                  <TabsList variant="pills" aria-label="Snippet language">
                    <TabsTrigger value="curl">cURL</TabsTrigger>
                    <TabsTrigger value="js">JavaScript</TabsTrigger>
                    <TabsTrigger value="py">Python</TabsTrigger>
                  </TabsList>
                  <TabsContent value="curl" className="text-body text-text-muted">
                    Content for cURL. Tabs with panels use the Root API.
                  </TabsContent>
                  <TabsContent value="js" className="text-body text-text-muted">
                    Content for JavaScript.
                  </TabsContent>
                  <TabsContent value="py" className="text-body text-text-muted">
                    Content for Python.
                  </TabsContent>
                </Tabs>
              </div>
            </Surfaces>
          </Section>

          <Section id="feedback" title="Feedback" description="Alerts are inline callouts; toasts are transient and announced politely. Danger alerts use role=alert.">
            <div className="grid gap-3 lg:grid-cols-2">
              <Alert variant="info" title="Checkpoints are commit-style">
                Creating one never interrupts the live database.
              </Alert>
              <Alert variant="success" title="Rollback complete">
                customer_portal is back at <span className="font-mono text-code text-text">a41f9c2</span>.
              </Alert>
              <Alert variant="warning" title="Mirror is 14 minutes behind" action={<Button size="xs" variant="secondary">Sync now</Button>}>
                The source host stopped responding at 16:21.
              </Alert>
              <Alert variant="danger" title="Sync failed">
                Access denied for user &apos;mirror&apos;@&apos;10.0.0.5&apos;.
              </Alert>
              <Alert variant="neutral">A neutral note without a title.</Alert>
            </div>
            <Surfaces>
              <div className="space-y-5">
                <Progress value={progress} label="Copying data directory" showValue />
                <Progress value={null} label="Waiting for MariaDB to stop" />
                <div className="grid gap-3 sm:grid-cols-2">
                  <Progress value={100} tone="success" aria-label="Done" />
                  <Progress value={64} tone="warn" aria-label="Warn" />
                  <Progress value={22} tone="danger" aria-label="Danger" />
                  <Progress value={50} tone="neutral" size="xs" aria-label="Neutral" />
                </div>
                <Row label="Spinner">
                  <Spinner size="xs" />
                  <Spinner size="sm" />
                  <Spinner />
                  <Spinner size="lg" />
                  <Spinner size="xl" className="text-accent" />
                </Row>
                <Row label="Skeleton">
                  <div className="w-full max-w-sm space-y-3">
                    <Skeleton className="h-4 w-1/3" />
                    <SkeletonRows rows={3} />
                  </div>
                </Row>
                <Row label="Toasts">
                  <Button size="sm" variant="secondary" onClick={() => toast.show("Checkpoint c90b5d4 created", "success")}>
                    Success
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => toast.show("Could not reach the mirror source", "error")}>
                    Error
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => toast.warning("Disk is 91% full", { description: "Prune old checkpoints or move the data directory." })}>
                    Warning
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      toast.info("Object deleted", { action: { label: "Undo", onClick: () => toast.success("Restored") } })
                    }
                  >
                    With action
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      toast.promise(new Promise((resolve) => setTimeout(resolve, 1800)), {
                        loading: "Rolling back to a41f9c2…",
                        success: "Rolled back to a41f9c2",
                        error: "Rollback failed",
                      })
                    }
                  >
                    Promise
                  </Button>
                </Row>
              </div>
            </Surfaces>
            <div className="grid gap-3 lg:grid-cols-3">
              <EmptyState icon={Database} title="No databases yet" description="Create one to get a schema, a user and a connection string." action={<Button size="sm"><Plus /> New database</Button>} />
              <EmptyState variant="dashed" size="sm" icon={History} title="No checkpoints" description="Create one to start the history." />
              <EmptyState variant="bare" size="sm" icon={<Zap className="size-4" />} title="Nothing ran in 24h" />
            </div>
          </Section>

          <Section id="overlays" title="Overlays" description="Dialogs portal to the body, trap focus, lock scroll and close on Escape. Initial focus goes to the first field, never the close button. Tall dialogs scroll inside a fixed header and footer.">
            <Frame>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => setDialogOpen(true)} data-testid="open-dialog">
                  Form dialog
                </Button>
                <Button variant="secondary" onClick={() => setTallOpen(true)} data-testid="open-tall">
                  Tall dialog
                </Button>
                <Button variant="secondary" onClick={() => setSecretOpen(true)} data-testid="open-secret">
                  Non-dismissible
                </Button>
                <Button variant="secondary" onClick={() => setConfirmOpen(true)} data-testid="open-confirm">
                  Confirm
                </Button>
                <Button variant="danger-soft" onClick={() => setDangerOpen(true)} data-testid="open-danger">
                  Destructive confirm
                </Button>
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="secondary" data-testid="open-sheet">
                      Sheet right
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="right" size="lg">
                    <SheetHeader>
                      <SheetTitle>Background jobs</SheetTitle>
                      <SheetDescription>Long operations keep running if you close this.</SheetDescription>
                    </SheetHeader>
                    <SheetBody className="space-y-5">
                      <Progress value={68} label="Roll back customer_portal" showValue />
                      <Progress value={null} label="Import orders.sql.gz" />
                      <Progress value={100} tone="success" label="Checkpoint c90b5d4" showValue />
                    </SheetBody>
                    <SheetFooter>
                      <Button variant="ghost" size="sm">
                        Clear finished
                      </Button>
                    </SheetFooter>
                  </SheetContent>
                </Sheet>
                <Sheet>
                  <SheetTrigger asChild>
                    <Button variant="secondary" data-testid="open-sheet-left">
                      Sheet left
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="left" aria-describedby={undefined}>
                    <SheetHeader>
                      <SheetTitle>
                        <BrandMark size="sm" />
                      </SheetTitle>
                    </SheetHeader>
                    <SheetBody className="space-y-0.5 px-2">
                      {[
                        [LayoutDashboard, "Dashboard", true],
                        [Database, "Databases", false],
                        [Braces, "Data API", false],
                        [Users, "Users", false],
                        [Network, "Network", false],
                        [Settings, "Settings", false],
                      ].map(([IconComp, label, active]) => {
                        const C = IconComp as typeof Database;
                        return (
                          <a
                            key={label as string}
                            href="#kit-overlays"
                            aria-current={active ? "page" : undefined}
                            className={cn(
                              "relative flex h-9 items-center gap-2.5 rounded-md px-3 text-body text-text-muted transition-colors hover:bg-bg-hover hover:text-text focus-ring",
                              active && "bg-bg-hover text-text before:absolute before:left-0 before:top-2 before:h-5 before:w-0.5 before:rounded-full before:bg-accent",
                            )}
                          >
                            <C className="size-4" aria-hidden /> {label as string}
                          </a>
                        );
                      })}
                    </SheetBody>
                  </SheetContent>
                </Sheet>
                <Button variant="outline" onClick={() => setCommandOpen(true)} data-testid="open-command">
                  <Search /> Command menu
                  <KbdGroup className="ml-1">
                    <Kbd>⌘</Kbd>
                    <Kbd>K</Kbd>
                  </KbdGroup>
                </Button>
              </div>
            </Frame>

            <Dialog
              open={dialogOpen}
              onClose={() => setDialogOpen(false)}
              title="Invite user"
              description="They get an email with a one-time link."
              footer={
                <>
                  <Button variant="ghost" onClick={() => setDialogOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={() => setDialogOpen(false)}>Send invite</Button>
                </>
              }
            >
              <div className="space-y-4">
                <Field label="Email" required>
                  <Input type="email" placeholder="jules@example.com" />
                </Field>
                <FieldGroup>
                  <Field label="Role">
                    <NativeSelect defaultValue="viewer">
                      <option value="admin">Admin</option>
                      <option value="viewer">Viewer</option>
                    </NativeSelect>
                  </Field>
                  <Field label="Expires">
                    <SelectMenu defaultValue="7d" options={[{ value: "1d", label: "1 day" }, { value: "7d", label: "7 days" }]} />
                  </Field>
                </FieldGroup>
              </div>
            </Dialog>

            <Dialog
              open={tallOpen}
              onClose={() => setTallOpen(false)}
              title="Create a database"
              size="2xl"
              footer={
                <>
                  <Button variant="ghost" onClick={() => setTallOpen(false)}>
                    Cancel
                  </Button>
                  <Button onClick={() => setTallOpen(false)}>
                    Provision database <ChevronRight />
                  </Button>
                </>
              }
            >
              <div className="space-y-5">
                <Field label="Display name" required>
                  <Input placeholder="Customer Portal" />
                </Field>
                <RadioGroup defaultValue="standard" aria-label="Type" className="grid gap-2.5 sm:grid-cols-2">
                  <RadioCard value="standard" icon={<Database />} title="Standard" description="A fresh, empty schema" />
                  <RadioCard value="mirror" icon={<ArrowLeftRight />} title="Mirror" description="Syncs from an external source" />
                </RadioGroup>
                <Switch label="Tailnet only" description="Restrict connections to your Tailscale network" defaultChecked />
                {Array.from({ length: 8 }, (_, i) => (
                  <Field key={i} label={`Extra field ${i + 1}`} hint="Here to make the dialog taller than the viewport">
                    <Input />
                  </Field>
                ))}
              </div>
            </Dialog>

            <Dialog
              open={secretOpen}
              onClose={() => setSecretOpen(false)}
              title="Database provisioned"
              description="This password is shown once. Escape and outside clicks are ignored until you confirm."
              dismissible={false}
              size="lg"
              footer={<Button onClick={() => setSecretOpen(false)}>I&apos;ve saved it</Button>}
            >
              <div className="space-y-4">
                <Alert variant="warning">Copy the password now. You can rotate it later, but not read it again.</Alert>
                <FieldGroup>
                  <CopyableField label="User" value="ld_customer_portal" />
                  <CopyableField label="Password" value="pW7#kq2Lz9!vR4mX8tNe" secret />
                </FieldGroup>
                <CopyableField label="Connection URL" value="mysql://ld_customer_portal:••••@10.0.0.5:3307/customer_portal" />
              </div>
            </Dialog>

            <ConfirmDialog
              open={confirmOpen}
              onClose={() => setConfirmOpen(false)}
              onConfirm={() => {
                setConfirmOpen(false);
                toast.show("Checkpoint created", "success");
              }}
              title="Create a checkpoint?"
              body="A commit-style checkpoint of customer_portal. The database stays online."
              confirmLabel="Create checkpoint"
            />

            <ConfirmDialog
              open={dangerOpen}
              onClose={() => setDangerOpen(false)}
              onConfirm={() => {
                setDangerLoading(true);
                setTimeout(() => {
                  setDangerLoading(false);
                  setDangerOpen(false);
                  toast.show("Database deleted", "success");
                }, 1200);
              }}
              loading={dangerLoading}
              tone="danger"
              title="Delete Customer Portal?"
              body="This drops the schema, its user and every checkpoint. It cannot be undone."
              challenge="customer_portal"
              confirmLabel="Delete database"
            />

            <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
              <CommandInput placeholder="Search pages, databases and actions" trailing={<Kbd>Esc</Kbd>} />
              <CommandList>
                <CommandEmpty>No results.</CommandEmpty>
                <CommandGroup heading="Actions">
                  <CommandItem onSelect={() => setCommandOpen(false)}>
                    <Plus /> New database
                    <CommandShortcut>N</CommandShortcut>
                  </CommandItem>
                  <CommandItem onSelect={() => setCommandOpen(false)}>
                    <GitCommitHorizontal /> Take checkpoint
                  </CommandItem>
                  <CommandItem onSelect={() => setCommandOpen(false)}>
                    <Upload /> Import a dump
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Databases">
                  {DB_ROWS.map((row) => (
                    <CommandItem key={row.schema} value={`${row.name} ${row.schema}`} onSelect={() => setCommandOpen(false)}>
                      <Database /> {row.name}
                      <span className="ml-auto font-mono text-micro text-text-subtle">{row.schema}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
                <CommandSeparator />
                <CommandGroup heading="Pages">
                  <CommandItem onSelect={() => setCommandOpen(false)}>
                    <LayoutDashboard /> Dashboard
                  </CommandItem>
                  <CommandItem onSelect={() => setCommandOpen(false)}>
                    <Settings /> Settings
                  </CommandItem>
                </CommandGroup>
              </CommandList>
            </CommandDialog>
          </Section>

          <Section id="menus" title="Menus and popovers" description="Menus are for actions; popovers hold small interactive panels; tooltips only label things.">
            <Surfaces>
              <div className="flex flex-wrap items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="secondary" data-testid="open-menu">
                      <Avatar size="sm" name="Avery Chen" /> Avery
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56">
                    <DropdownMenuLabel>admin@lambdata.local</DropdownMenuLabel>
                    <DropdownMenuGroup>
                      <DropdownMenuItem>
                        <User /> Profile <DropdownMenuShortcut>⌘P</DropdownMenuShortcut>
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <KeyRound /> API tokens
                      </DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Pencil /> Sort by
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent>
                          <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
                            <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="size">Size</DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="created">Created</DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Columns</DropdownMenuLabel>
                    <DropdownMenuCheckboxItem
                      checked={showColumns.size}
                      onCheckedChange={(v) => setShowColumns((c) => ({ ...c, size: v === true }))}
                    >
                      Size
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuCheckboxItem
                      checked={showColumns.tables}
                      onCheckedChange={(v) => setShowColumns((c) => ({ ...c, tables: v === true }))}
                    >
                      Tables
                    </DropdownMenuCheckboxItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled>
                      <Play /> Disabled item
                    </DropdownMenuItem>
                    <DropdownMenuItem variant="danger">
                      <LogOut /> Sign out
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="ghost" size="icon" aria-label="Notifications" data-testid="open-popover">
                      <Bell />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-80 p-0">
                    <div className="flex items-center justify-between border-b border-border px-4 py-3">
                      <span className="text-heading font-semibold">Notifications</span>
                      <Button variant="link" size="xs">
                        Mark all read
                      </Button>
                    </div>
                    <ul className="divide-y divide-border">
                      {["Checkpoint c90b5d4 created", "Mirror sync failed", "Jules joined as viewer"].map((n, i) => (
                        <li key={n} className="flex items-start gap-3 px-4 py-3">
                          <StatusDot tone={i === 1 ? "danger" : "muted"} className="mt-1.5" />
                          <div className="min-w-0">
                            <div className="text-body text-text">{n}</div>
                            <div className="text-micro text-text-subtle">{i + 2}m ago</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </PopoverContent>
                </Popover>
                <SimpleTooltip content="Tooltips label; they never hold actions" side="bottom">
                  <Button variant="outline" size="sm" data-testid="tooltip-trigger">
                    Hover or focus me
                  </Button>
                </SimpleTooltip>
              </div>
            </Surfaces>
          </Section>

          <Section id="data" title="Data display" description="Copy works over plain HTTP with an execCommand fallback and reports success or failure. Secrets are masked until revealed.">
            <Surfaces>
              <div className="space-y-5">
                <FieldGroup>
                  <CopyableField label="Host" value="10.0.0.5:3307" />
                  <CopyableField label="Password" value="pW7#kq2Lz9!vR4mX8tNe" secret />
                  <CopyableField label="Invoke URL" value="https://lambdata.tail1234.ts.net/functions/v1/stripe-webhook" />
                  <CopyableField label="Display name" value="Customer Portal" monospace={false} size="sm" />
                </FieldGroup>
                <div className="flex items-center gap-2 text-label text-text-muted">
                  Standalone copy button: <span className="font-mono text-code text-text">c90b5d4</span>
                  <CopyButton value="c90b5d4" label="checkpoint hash" />
                  <CopyButton value="c90b5d4" label="checkpoint hash" showText variant="secondary" size="xs" />
                  <CopyButton value={"host=10.0.0.5\nport=3307"} label="credentials" text="Copy all" copiedText="Copied all" variant="secondary" size="xs" />
                </div>
              </div>
            </Surfaces>
            <div className="grid gap-3 xl:grid-cols-2">
              <CodeBlock code={SAMPLE_SQL} language="sql" title="Recent orders" />
              <CodeBlock code={SAMPLE_SQL} language="sql" lineNumbers wrap maxHeight={180} />
              <CodeBlock className="self-start" code={'curl -H "apikey: $LAMBDATA_ANON" https://lambdata.local/api/v1/orders?limit=5'} wrapToggle={false} />
              <Frame>
                <div className="space-y-4">
                  <Row label="Avatar">
                    <Avatar size="sm" name="Jules Moreau" />
                    <Avatar name="admin@lambdata.local" />
                    <Avatar size="lg" name="Ada" />
                    <Avatar size="lg" name="Broken Image" src="/missing.png" />
                  </Row>
                  <Row label="Breadcrumb">
                    <Breadcrumb>
                      <BreadcrumbList>
                        <BreadcrumbItem>
                          <BreadcrumbLink href="#kit-data">Databases</BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          <BreadcrumbEllipsis />
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          <BreadcrumbLink href="#kit-data">Customer Portal</BreadcrumbLink>
                        </BreadcrumbItem>
                        <BreadcrumbSeparator />
                        <BreadcrumbItem>
                          <BreadcrumbPage>History</BreadcrumbPage>
                        </BreadcrumbItem>
                      </BreadcrumbList>
                    </Breadcrumb>
                  </Row>
                  <Row label="Separator">
                    <span className="text-label">left</span>
                    <Separator orientation="vertical" className="h-4" />
                    <span className="text-label">right</span>
                  </Row>
                  <Row label="Scroll area">
                    <ScrollArea className="h-28 w-full rounded-md border border-border" tabIndex={-1}>
                      <ul className="p-2">
                        {Array.from({ length: 14 }, (_, i) => (
                          <li key={i} className="rounded px-2 py-1 font-mono text-code text-text-muted hover:bg-bg-hover">
                            checkpoint_{String(i + 1).padStart(2, "0")}
                          </li>
                        ))}
                      </ul>
                    </ScrollArea>
                  </Row>
                </div>
              </Frame>
            </div>
          </Section>

          <Section id="disclosure" title="Disclosure" description="Accordion for grouped sections; Collapsible for a single show-more.">
            <div className="grid gap-3 lg:grid-cols-2">
              <Card className="py-1">
                <Accordion type="single" collapsible defaultValue="a">
                  <AccordionItem value="a">
                    <AccordionTrigger>What is a checkpoint?</AccordionTrigger>
                    <AccordionContent>A named, commit-style snapshot of one database that you can roll back to or branch from.</AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="b">
                    <AccordionTrigger>Does it lock tables?</AccordionTrigger>
                    <AccordionContent>No. Creating a checkpoint never interrupts the live database.</AccordionContent>
                  </AccordionItem>
                  <AccordionItem value="c">
                    <AccordionTrigger>Where are they stored?</AccordionTrigger>
                    <AccordionContent>In the data directory, next to the MariaDB files.</AccordionContent>
                  </AccordionItem>
                </Accordion>
              </Card>
              <Card>
                <Collapsible>
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <CardTitle>Audit event</CardTitle>
                      <CardDescription>database.update · 2m ago</CardDescription>
                    </div>
                    <CollapsibleTrigger asChild>
                      <Button variant="ghost" size="sm" className="group">
                        Details
                        <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" />
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                  <CollapsibleContent>
                    <CodeBlock className="mt-4" code={JSON.stringify({ id: "db_8f2", field: "showInVitals", from: false, to: true }, null, 2)} language="json" wrapToggle={false} />
                  </CollapsibleContent>
                </Collapsible>
              </Card>
            </div>
          </Section>

          <Section id="dropzone" title="File dropzone" description="Drag and drop, click, or focus and press Enter or Space. Rejections are reported inline; the input resets so the same file can be picked again.">
            <div className="grid gap-3 lg:grid-cols-2">
              <FileDropzone
                accept=".sql,.gz,.zip"
                maxSize={2 * 1024 ** 3}
                description="SQL dump, .sql.gz or .zip, up to 2 GB"
                files={files}
                onFiles={(next) => setFiles(next)}
                onRemove={() => setFiles([])}
              />
              <div className="space-y-3">
                <FileDropzone compact onFiles={() => undefined} multiple description="Compact variant, multiple files" />
                <FileDropzone compact disabled onFiles={() => undefined} description="Disabled while an import runs" />
                <FileDropzone compact onFiles={() => undefined} error="orders.csv is not an accepted file type" description="With an error" />
              </div>
            </div>
          </Section>

          <Section
            id="operations"
            title="Operation states"
            description="How finished jobs read across the console: a refusal changed nothing and may offer a forced rollback, finished with errors is amber with the objects that are missing, and a failure keeps its full message readable. Built from mocked jobs."
          >
            <OperationStates />
          </Section>

          <Section
            id="narrow"
            title="Narrow layouts"
            description="Cases that used to break on phones: header and alert actions wrap below the text when there is no room, a segmented control keeps its natural width inside a Field, and theme swatches come from CSS variables."
          >
            <div className="grid gap-3 lg:grid-cols-2">
              <Card>
                <CardHeader
                  title="Checkpoint schedule"
                  description="How often LambData records a commit-style checkpoint of this database."
                  action={
                    <Button size="sm" variant="secondary">
                      <Pencil /> Edit schedule
                    </Button>
                  }
                />
                <p className="text-body text-text-muted">Card body.</p>
              </Card>
              <Alert
                variant="warning"
                title="Mirror is 14 minutes behind"
                action={
                  <>
                    <Button size="xs" variant="secondary">
                      Sync now
                    </Button>
                    <Button size="xs" variant="ghost">
                      Details
                    </Button>
                  </>
                }
              >
                The source host stopped responding at 16:21 and two retries timed out.
              </Alert>
              <Card>
                <div className="space-y-4">
                  <Field label="Range" hint="Natural width inside a Field">
                    <SegmentedControl
                      aria-label="Range in field"
                      defaultValue="7d"
                      options={[
                        { value: "24h", label: "24h" },
                        { value: "7d", label: "7d" },
                        { value: "30d", label: "30d" },
                      ]}
                    />
                  </Field>
                  <Field label="Density" hint="fullWidth fills the field">
                    <SegmentedControl
                      aria-label="Density in field"
                      fullWidth
                      defaultValue="cozy"
                      options={[
                        { value: "compact", label: "Compact" },
                        { value: "cozy", label: "Cozy" },
                      ]}
                    />
                  </Field>
                </div>
              </Card>
              <Card>
                <SectionLabel>Theme swatches</SectionLabel>
                <div className="space-y-2.5">
                  {COLOR_THEMES.map((t) => (
                    <div key={t.value} className="flex items-center gap-3 text-body">
                      <ThemeSwatches theme={t.value} />
                      <span className="flex items-center -space-x-1" data-palette-preview={t.value} aria-hidden>
                        {[1, 2, 3].map((n) => (
                          <span key={n} className={cn(`palette-preview__swatch--${n}`, "size-3 rounded-full ring-2 ring-bg-raised")} />
                        ))}
                      </span>
                      <span className="text-text">{t.label}</span>
                      <span className="truncate text-label text-text-subtle">{t.description}</span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-micro text-text-subtle">
                  Left: ThemeSwatches (inline CSS variables). Right: legacy classes built at runtime, kept outside the purgeable layer.
                </p>
              </Card>
            </div>
          </Section>

        </main>
      </div>
    </div>
  );
}

export default KitPage;
