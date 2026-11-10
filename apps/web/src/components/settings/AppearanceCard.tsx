import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ColorTheme, User, VitalsChartStyle } from "@lambdata/shared";
import { Badge, Button, Card, RadioCard, RadioGroup, StatusDot, Switch, cn, useToast } from "../ui";
import { api, errorMessage } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { COLOR_THEMES, DEFAULT_COLOR_THEME, applyColorTheme } from "../../lib/theme";

const SWATCHES = ["palette-preview__swatch--1", "palette-preview__swatch--2", "palette-preview__swatch--3"];

const CHART_STYLES: { value: VitalsChartStyle; label: string; description: string }[] = [
  { value: "area", label: "Area", description: "Smooth stacked history" },
  { value: "capsules", label: "Capsules", description: "One rounded bar per sample" },
];

export function useUpdateMe(user: User) {
  const { refetch } = useAuth();
  return useMutation({
    mutationFn: (body: Partial<Pick<User, "colorTheme" | "vitalsChartStyle" | "dataViewEnabled" | "experienceLevel">>) =>
      api.patch<{ user: User }>(`/users/${encodeURIComponent(user.id)}`, body),
    onSuccess: () => refetch(),
  });
}

export function AppearanceCard({ user }: { user: User }) {
  const toast = useToast();
  const theme = useUpdateMe(user);
  const chart = useUpdateMe(user);
  const strip = useUpdateMe(user);
  const [selectedTheme, setSelectedTheme] = useState<ColorTheme>(user.colorTheme ?? DEFAULT_COLOR_THEME);
  const [selectedChart, setSelectedChart] = useState<VitalsChartStyle>(user.vitalsChartStyle);

  useEffect(() => {
    if (!theme.isPending) setSelectedTheme(user.colorTheme ?? DEFAULT_COLOR_THEME);
  }, [user.colorTheme]);

  useEffect(() => {
    if (!chart.isPending) setSelectedChart(user.vitalsChartStyle);
  }, [user.vitalsChartStyle]);

  const pickTheme = (value: ColorTheme) => {
    const previous = selectedTheme;
    setSelectedTheme(value);
    applyColorTheme(value, true);
    theme.mutate(
      { colorTheme: value },
      {
        onError: (e) => {
          setSelectedTheme(previous);
          applyColorTheme(previous, true);
          toast.error(errorMessage(e, "Could not save the theme"));
        },
      },
    );
  };

  const pickChart = (value: VitalsChartStyle) => {
    const previous = selectedChart;
    setSelectedChart(value);
    chart.mutate(
      { vitalsChartStyle: value },
      {
        onError: (e) => {
          setSelectedChart(previous);
          toast.error(errorMessage(e, "Could not save the chart style"));
        },
      },
    );
  };

  return (
    <Card className="space-y-6">
      <div className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="theme-label" className="text-body font-medium text-text">
            Theme
          </h3>
          <span className="text-micro text-text-subtle">Applies as you pick, on every device you sign in from.</span>
        </div>
        <RadioGroup
          aria-labelledby="theme-label"
          value={selectedTheme}
          onValueChange={(v) => pickTheme(v as ColorTheme)}
          className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3"
        >
          {COLOR_THEMES.map((t) => (
            <RadioCard
              key={t.value}
              value={t.value}
              layout="inline"
              title={t.label}
              description={t.description}
              badge={
                t.value === DEFAULT_COLOR_THEME ? (
                  <Badge size="sm" variant="muted">
                    default
                  </Badge>
                ) : undefined
              }
              icon={
                <span className="flex items-center -space-x-1" data-palette-preview={t.value} aria-hidden>
                  {SWATCHES.map((swatch) => (
                    <span key={swatch} className={cn(swatch, "size-3 rounded-full ring-2 ring-bg-raised")} />
                  ))}
                </span>
              }
            />
          ))}
        </RadioGroup>
        <ThemePreview />
      </div>

      <div className="space-y-3 border-t border-border pt-5">
        <h3 id="chart-style-label" className="text-body font-medium text-text">
          Dashboard vitals chart
        </h3>
        <RadioGroup
          aria-labelledby="chart-style-label"
          value={selectedChart}
          onValueChange={(v) => pickChart(v as VitalsChartStyle)}
          className="grid gap-2.5 sm:grid-cols-2"
        >
          {CHART_STYLES.map((style) => (
            <RadioCard
              key={style.value}
              value={style.value}
              layout="inline"
              title={style.label}
              description={style.description}
              icon={<ChartStyleGlyph style={style.value} />}
            />
          ))}
        </RadioGroup>
      </div>

      <div className="border-t border-border pt-5">
        <Switch
          checked={user.dataViewEnabled}
          disabled={strip.isPending}
          onCheckedChange={(dataViewEnabled) =>
            strip.mutate(
              { dataViewEnabled },
              {
                onSuccess: () => toast.success(dataViewEnabled ? "Vitals strip shown" : "Vitals strip hidden"),
                onError: (e) => toast.error(errorMessage(e, "Could not save the setting")),
              },
            )
          }
          label="Vitals strip on database overviews"
          description="A 24-hour size ribbon, write activity and table, row and connection counts. Built from periodic metadata polls; no row contents are read."
        />
      </div>
    </Card>
  );
}

function ThemePreview() {
  return (
    <div
      aria-label="Theme preview"
      role="img"
      className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border border-border bg-bg px-4 py-3"
    >
      <span className="text-micro text-text-subtle">Preview</span>
      <Button size="xs" tabIndex={-1} aria-hidden>
        Primary
      </Button>
      <Button size="xs" variant="secondary" tabIndex={-1} aria-hidden>
        Secondary
      </Button>
      <Badge variant="accent" mono size="sm">
        HEAD
      </Badge>
      <span className="inline-flex items-center gap-1.5 text-label text-text-muted">
        <StatusDot tone="success" /> running
      </span>
      <span className="flex h-6 items-end gap-0.5" aria-hidden>
        {[0.45, 0.7, 0.55, 0.9, 0.65, 1].map((h, i) => (
          <span
            key={i}
            className="w-1.5 rounded-sm"
            style={{ height: `${h * 100}%`, backgroundColor: `rgb(var(--chart-${i + 1}))` }}
          />
        ))}
      </span>
    </div>
  );
}

function ChartStyleGlyph({ style }: { style: VitalsChartStyle }) {
  return (
    <svg aria-hidden viewBox="0 0 64 40" className="h-[18px] w-7 overflow-visible">
      {style === "area" ? (
        <>
          <path
            d="M1 34 C10 33 13 27 21 28 C30 30 33 17 42 19 C51 20 54 8 63 7 L63 39 L1 39 Z"
            fill="rgb(var(--chart-1))"
            fillOpacity="0.24"
          />
          <path
            d="M1 34 C10 33 13 27 21 28 C30 30 33 17 42 19 C51 20 54 8 63 7"
            fill="none"
            stroke="rgb(var(--chart-1))"
            strokeWidth="3"
          />
        </>
      ) : (
        Array.from({ length: 7 }, (_, i) => {
          const height = 12 + i * 3.6 + (i % 3) * 3;
          return (
            <rect key={i} x={2 + i * 9} y={39 - height} width="6" height={height} rx="3" fill="rgb(var(--chart-1))" opacity={0.45 + i * 0.08} />
          );
        })
      )}
    </svg>
  );
}
