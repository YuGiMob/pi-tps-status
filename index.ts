import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  MessageStartEvent,
  MessageEndEvent,
  MessageUpdateEvent,
} from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type DisplayMode = "tps" | "ttft" | "stats" | "full";
type CountStrategy = "estimate" | "direct" | "provider";
type EndTpsBehavior = "average" | "last";
type CountingSource = "provider" | "estimate" | "direct";

export interface TokenSpeedConfig {
  display: DisplayMode;
  tpsSlow: number;
  tpsMedium: number;
  tpsFast: number;
  tpsBlazing: number;
  colorSlow: string;
  colorMedium: string;
  colorFast: string;
  colorBlazing: string;
  slidingWindow: number;
  useProviderTokens: boolean;
  countStrategy: CountStrategy;
  endTpsBehavior: EndTpsBehavior;
}

const STATUS_KEY = "tps";
const CHARS_PER_TOKEN = 4;
const MIN_SPAN_MS = 250;
const MIN_WINDOW_MS = 100;
const MAX_WINDOW_MS = 30000;
const MAX_BACKDATED_SAMPLES = 32;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DISPLAY_MODES: readonly DisplayMode[] = ["tps", "ttft", "stats", "full"];
const COUNT_STRATEGIES: readonly CountStrategy[] = ["estimate", "direct", "provider"];
const END_BEHAVIORS: readonly EndTpsBehavior[] = ["average", "last"];

const DEFAULT_CONFIG: TokenSpeedConfig = {
  display: "tps",
  tpsSlow: 0,
  tpsMedium: 15,
  tpsFast: 30,
  tpsBlazing: 45,
  colorSlow: "#ff4444",
  colorMedium: "#ffaa00",
  colorFast: "#00ff88",
  colorBlazing: "#44ddff",
  slidingWindow: 1000,
  useProviderTokens: true,
  countStrategy: "provider",
  endTpsBehavior: "average",
};

const TOGGLE_VALUES = ["on", "off"] as const;

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  label: string,
  errors: string[],
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  errors.push(`- Invalid ${label} "${String(value)}" - defaulting to "${fallback}".`);
  return fallback;
}

function pickNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  label: string,
  errors: string[],
): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) {
    return value;
  }
  errors.push(`- Invalid ${label} "${String(value)}" - defaulting to ${fallback}.`);
  return fallback;
}

function pickBoolean(value: unknown, fallback: boolean, label: string, errors: string[]): boolean {
  if (typeof value === "boolean") return value;
  errors.push(`- Invalid ${label} "${String(value)}" - defaulting to ${fallback}.`);
  return fallback;
}

function pickColor(value: unknown, fallback: string, label: string, errors: string[]): string {
  if (typeof value === "string" && HEX_COLOR.test(value)) return value;
  errors.push(`- Invalid ${label} "${String(value)}" - defaulting to ${fallback}.`);
  return fallback;
}

function thresholdErrors(config: TokenSpeedConfig): string[] {
  if (
    config.tpsSlow < config.tpsMedium &&
    config.tpsMedium < config.tpsFast &&
    config.tpsFast < config.tpsBlazing
  ) {
    return [];
  }
  return [
    "- TPS thresholds must be strictly ascending.",
    `  Found: ${config.tpsSlow} < ${config.tpsMedium} < ${config.tpsFast} < ${config.tpsBlazing}.`,
  ];
}

export function validateConfig(raw: unknown): { config: TokenSpeedConfig; errors: string[] } {
  const errors: string[] = [];
  const input = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const merged = { ...DEFAULT_CONFIG, ...input };
  const config: TokenSpeedConfig = {
    display: pickEnum(merged.display, DISPLAY_MODES, DEFAULT_CONFIG.display, "display", errors),
    tpsSlow: pickNumber(merged.tpsSlow, 0, 1e6, DEFAULT_CONFIG.tpsSlow, "tpsSlow", errors),
    tpsMedium: pickNumber(merged.tpsMedium, 0, 1e6, DEFAULT_CONFIG.tpsMedium, "tpsMedium", errors),
    tpsFast: pickNumber(merged.tpsFast, 0, 1e6, DEFAULT_CONFIG.tpsFast, "tpsFast", errors),
    tpsBlazing: pickNumber(merged.tpsBlazing, 0, 1e6, DEFAULT_CONFIG.tpsBlazing, "tpsBlazing", errors),
    colorSlow: pickColor(merged.colorSlow, DEFAULT_CONFIG.colorSlow, "colorSlow", errors),
    colorMedium: pickColor(merged.colorMedium, DEFAULT_CONFIG.colorMedium, "colorMedium", errors),
    colorFast: pickColor(merged.colorFast, DEFAULT_CONFIG.colorFast, "colorFast", errors),
    colorBlazing: pickColor(merged.colorBlazing, DEFAULT_CONFIG.colorBlazing, "colorBlazing", errors),
    slidingWindow: pickNumber(
      merged.slidingWindow,
      MIN_WINDOW_MS,
      MAX_WINDOW_MS,
      DEFAULT_CONFIG.slidingWindow,
      "slidingWindow",
      errors,
    ),
    useProviderTokens: pickBoolean(
      merged.useProviderTokens,
      DEFAULT_CONFIG.useProviderTokens,
      "useProviderTokens",
      errors,
    ),
    countStrategy: pickEnum(
      merged.countStrategy,
      COUNT_STRATEGIES,
      DEFAULT_CONFIG.countStrategy,
      "countStrategy",
      errors,
    ),
    endTpsBehavior: pickEnum(
      merged.endTpsBehavior,
      END_BEHAVIORS,
      DEFAULT_CONFIG.endTpsBehavior,
      "endTpsBehavior",
      errors,
    ),
  };
  errors.push(...thresholdErrors(config));
  return { config, errors };
}

function configBase(): string {
  if (process.platform !== "win32") {
    const xdg = process.env.XDG_CONFIG_HOME;
    if (xdg && xdg.length > 0) return xdg;
  }
  return join(homedir(), ".config");
}

function configPath(): string {
  return join(configBase(), "pi-tps-status", "config.json");
}

function errCode(error: unknown): string | undefined {
  if (error instanceof Error) return (error as NodeJS.ErrnoException).code;
  return undefined;
}

const TEMP_PREFIX = ".tmp-";
const TEMP_UUID_RE =
  /^\.tmp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STALE_TEMP_MS = 60 * 60 * 1000;
const sweptDirs = new Set<string>();

async function sweepStaleTemps(dir: string): Promise<void> {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.isFile() || !TEMP_UUID_RE.test(entry.name)) continue;
      const tempPath = join(dir, entry.name);
      try {
        const stats = await stat(tempPath);
        if (now - stats.mtimeMs > STALE_TEMP_MS) {
          await rm(tempPath, { force: true });
        }
      } catch {}
    }
  } catch {}
}

async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {}
}

async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {}
}

async function writeAtomic(path: string, content: string): Promise<void> {
  let existingMode: number | null = null;
  try {
    existingMode = (await stat(path)).mode & 0o7777;
  } catch (error) {
    if (errCode(error) !== "ENOENT") throw error;
  }
  const dir = dirname(path);
  await sweepStaleTemps(dir);
  await mkdir(dir, { recursive: true });
  const tempPath = join(dir, `${TEMP_PREFIX}${randomUUID()}`);
  const tempHandle = await open(tempPath, "wx", 0o600);
  try {
    await tempHandle.writeFile(content, "utf-8");
    if (existingMode !== null) await tempHandle.chmod(existingMode);
    await tempHandle.sync();
  } catch (error) {
    await tempHandle.close();
    await removeQuietly(tempPath);
    throw error;
  }
  await tempHandle.close();
  try {
    await rename(tempPath, path);
    await syncDir(dir);
  } catch (error) {
    if (process.platform === "win32" && errCode(error) === "EPERM") {
      try {
        await writeFile(path, content, "utf-8");
        return;
      } finally {
        await removeQuietly(tempPath);
      }
    }
    await removeQuietly(tempPath);
    throw error;
  }
}

export class SettingsStore {
  private cached: TokenSpeedConfig = DEFAULT_CONFIG;
  private errors: string[] = [];
  private readonly path = configPath();

  get config(): TokenSpeedConfig {
    return this.cached;
  }

  get validationErrors(): string[] {
    return this.errors;
  }

  async initialize(): Promise<void> {
    const result = validateConfig(await this.readAll());
    this.cached = result.config;
    this.errors = result.errors;
  }

  async update(partial: Partial<TokenSpeedConfig>): Promise<void> {
    const current = (await this.readAll()) ?? {};
    const result = validateConfig({ ...current, ...partial });
    await writeAtomic(this.path, JSON.stringify(result.config, null, 2));
    this.cached = result.config;
    this.errors = result.errors;
  }

  private async readAll(): Promise<Record<string, unknown> | null> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if (errCode(error) !== "ENOENT") {
        console.error("Config file corrupted, using defaults:", error);
      }
      return null;
    }
  }
}

const settings = new SettingsStore();

interface TokenSample {
  t: number;
  cum: number;
}

export class TpsMeter {
  private _tokens = 0;
  private samples: TokenSample[] = [];
  private isStreaming = false;
  private isPaused = false;
  private startTime = 0;
  private endTime = 0;
  private pausedMs = 0;
  private pauseStart = 0;
  private ttftStart = 0;
  private ttftEnd = 0;
  private lastRate: number | null = null;
  private lastRateSource: CountingSource | null = null;
  private _countingSource: CountingSource | null = null;
  private fallbackTokens = 0;
  private uncoveredFallback = 0;
  private segmentSettled = true;
  private countedUsage = 0;
  private usageAnchorTime = 0;
  private usageAnchorTokens = 0;
  private windowMs = DEFAULT_CONFIG.slidingWindow;
  private useProviderTokens = DEFAULT_CONFIG.useProviderTokens;
  private strategy: CountStrategy = DEFAULT_CONFIG.countStrategy;
  private endBehavior: EndTpsBehavior = DEFAULT_CONFIG.endTpsBehavior;
  configure(config: TokenSpeedConfig): void {
    this.windowMs = config.slidingWindow;
    this.useProviderTokens = config.useProviderTokens;
    this.strategy = config.countStrategy;
    this.endBehavior = config.endTpsBehavior;
  }

  startTtft(): void {
    this.ttftStart = Date.now();
    this.ttftEnd = 0;
  }

  stopTtft(): void {
    if (this.ttftEnd === 0) this.ttftEnd = Date.now();
  }

  start(): void {
    if (this.isStreaming) return;
    this.samples = [];
    this._tokens = 0;
    this.pausedMs = 0;
    this.countedUsage = 0;
    this.isPaused = false;
    this.lastRate = null;
    this.lastRateSource = null;
    this._countingSource = null;
    this.fallbackTokens = 0;
    this.uncoveredFallback = 0;
    this.segmentSettled = false;
    this.startTime = Date.now();
    this.endTime = this.startTime;
    this.usageAnchorTime = this.startTime;
    this.usageAnchorTokens = 0;
    this.isStreaming = true;
  }

  startMessage(): void {
    if (!this.segmentSettled) this.uncoveredFallback += this.fallbackTokens;
    this.fallbackTokens = 0;
    this.segmentSettled = false;
    this.countedUsage = 0;
    this.usageAnchorTime = Date.now();
    this.usageAnchorTokens = this._tokens;
  }

  stop(): void {
    if (!this.isStreaming) return;
    this.isStreaming = false;
    this.endTime = Date.now();
    this.lastRate = this.windowRate() ?? this.averageRate();
    this.lastRateSource = this._countingSource;
  }

  pause(): void {
    if (!this.isStreaming || this.isPaused) return;
    this.isPaused = true;
    this.pauseStart = Date.now();
  }

  resume(): void {
    if (!this.isStreaming || !this.isPaused) return;
    this.pausedMs += Date.now() - this.pauseStart;
    this.isPaused = false;
  }

  recordDelta(delta: string): void {
    if (!this.isStreaming) return;
    if (this.isPaused) {
      this.pausedMs += Date.now() - this.pauseStart;
      this.isPaused = false;
    }
    if (this.strategy !== "provider") {
      this.recordTokens(this.strategy === "estimate" ? this.estimateTokens(delta) : 1, Date.now());
    }
  }

  private useProviderCounting(): boolean {
    return this.useProviderTokens || this.strategy === "provider";
  }

  reconcile(providerOutput: number): void {
    if (!this.segmentSettled) this.uncoveredFallback += this.fallbackTokens;
    this.fallbackTokens = 0;
    this.segmentSettled = true;
    const total = providerOutput + this.uncoveredFallback;
    if (total > 0) {
      this._tokens = total;
      if (providerOutput > 0) this._countingSource = "provider";
    }
  }

  recordFinalUsage(output: number | undefined): void {
    if (!this.isStreaming || !this.useProviderCounting() || output === undefined || output <= this.countedUsage) return;
    this.recordProviderUsage(output, Date.now());
  }

  get tps(): number | null {
    if (this.isStreaming || this.endBehavior === "last") return this.lastRate;
    return this.averageRate();
  }

  get tpsSource(): CountingSource | null {
    if (this.isStreaming || this.endBehavior === "last") return this.lastRateSource;
    return this._countingSource;
  }

  get tokens(): number {
    return this._tokens;
  }

  get ttftMs(): number {
    return Math.max(this.ttftEnd - this.ttftStart, 0);
  }

  get elapsedSeconds(): number {
    if (this.startTime === 0) return 0;
    const end = this.isStreaming ? Date.now() : this.endTime;
    return this.activeMs(end) / 1000;
  }

  private activeMs(end: number): number {
    const currentPause = this.isPaused ? end - this.pauseStart : 0;
    return end - this.startTime - this.pausedMs - currentPause;
  }

  private recordProviderUsage(usageOutput: number, now: number): void {
    const firstReport = this.countedUsage === 0;
    const jump = usageOutput - this.countedUsage;
    this.countedUsage = usageOutput;
    this.segmentSettled = true;
    this.fallbackTokens = 0;
    if (firstReport) {
      this.samples = this.samples.filter((sample) => sample.t < this.usageAnchorTime);
      this._tokens = this.usageAnchorTokens;
      this.pushSample(this.usageAnchorTime, this.usageAnchorTokens);
    }
    const span = Math.max(now - this.usageAnchorTime, 1);
    const count = Math.min(Math.max(Math.ceil(jump / 16), 1), MAX_BACKDATED_SAMPLES);
    for (let i = 1; i <= count; i++) {
      this.pushSample(
        this.usageAnchorTime + (span * i) / count,
        this._tokens + (jump * i) / count,
      );
    }
    this._tokens += jump;
    this.usageAnchorTime = now;
    this._countingSource = "provider";
    this.lastRate = this.windowRate() ?? this.averageRate();
    this.lastRateSource = "provider";
  }

  private recordTokens(added: number, now: number): void {
    if (added <= 0) return;
    this._tokens += added;
    this.fallbackTokens += added;
    this.pushSample(now, this._tokens);
    this._countingSource = this.strategy === "estimate" ? "estimate" : "direct";
    this.lastRate = this.windowRate() ?? this.averageRate();
    this.lastRateSource = this._countingSource;
  }

  private pushSample(time: number, cum: number): void {
    this.samples.push({ t: time, cum });
    const cutoff = time - this.windowMs;
    while (this.samples.length > 1 && this.samples[0].t < cutoff) {
      this.samples.shift();
    }
  }

  private windowRate(): number | null {
    if (this.samples.length < 2) return null;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const spanMs = last.t - first.t;
    if (spanMs < MIN_SPAN_MS) return null;
    return ((last.cum - first.cum) * 1000) / spanMs;
  }

  private averageRate(): number | null {
    const elapsedMs = this.activeMs(this.isStreaming ? Date.now() : this.endTime);
    if (elapsedMs < MIN_SPAN_MS || this._tokens <= 0) return null;
    return (this._tokens * 1000) / elapsedMs;
  }

  private estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }
}

export class StatusRenderer {
  constructor(private readonly meter: TpsMeter) {}

  initialize(ctx: ExtensionContext): void {
    ctx.ui.setStatus(STATUS_KEY, `${ctx.ui.theme.fg("dim", "⚡ TPS:")} --`);
  }

  update(ctx: ExtensionContext): void {
    const config = settings.config;
    const rate = this.meter.tps;
    const value =
      rate === null
        ? "--"
        : this.colorize(`${rate.toFixed(1)} tok/s`, this.tierColor(config, rate));
    const sourceTag =
      rate === null ? "" : ` ${ctx.ui.theme.fg("dim", this.sourceLabel())}`;
    ctx.ui.setStatus(STATUS_KEY, `${ctx.ui.theme.fg("dim", "⚡ TPS:")} ${value}${sourceTag}${this.suffix(config)}`);
  }

  private sourceLabel(): string {
    if (this.meter.tpsSource === "provider") return "[provider]";
    if (this.meter.tpsSource === "estimate") return "[est]";
    if (this.meter.tpsSource === "direct") return "[chunk]";
    return "";
  }

  private tierColor(config: TokenSpeedConfig, rate: number): string {
    if (rate >= config.tpsBlazing) return config.colorBlazing;
    if (rate >= config.tpsFast) return config.colorFast;
    if (rate >= config.tpsMedium) return config.colorMedium;
    if (rate >= config.tpsSlow) return config.colorSlow;
    return "";
  }

  private colorize(text: string, hex: string): string {
    if (!HEX_COLOR.test(hex)) return text;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  }

  private suffix(config: TokenSpeedConfig): string {
    const ttft = `TTFT: ${Math.round(this.meter.ttftMs)} ms`;
    const stats = `${this.meter.tokens} tok in ${this.meter.elapsedSeconds.toFixed(1)}s`;
    if (config.display === "ttft") return ` (${ttft})\u200b`;
    if (config.display === "stats") return ` (${stats})\u200b`;
    if (config.display === "full") return ` (${stats} \u00b7 ${ttft})\u200b`;
    return "\u200b";
  }
}

function notifyValidationErrors(ctx: ExtensionContext, errors: string[]): void {
  if (errors.length === 0) return;
  ctx.ui.notify(["[pi-tps-status]", ...errors].join("\n"), "warning");
}

class TpsCommands {
  constructor(
    private readonly meter: TpsMeter,
    private readonly renderer: StatusRenderer,
  ) {}

  async run(ctx: ExtensionCommandContext): Promise<void> {
    const items = this.buildItems(settings.config);
    await ctx.ui.custom<void>((_tui, _theme, _kb, done) =>
      new SettingsList(
        items,
        items.length,
        getSettingsListTheme(),
        (id, value) => void this.apply(id, value, ctx),
        done,
      ),
    );
  }

  private async apply(id: string, value: string, ctx: ExtensionCommandContext): Promise<void> {
    const partial: Partial<TokenSpeedConfig> = {};
    if (id === "display") partial.display = value as DisplayMode;
    if (id === "useProviderTokens") partial.useProviderTokens = value === "on";
    if (id === "countStrategy") partial.countStrategy = value as CountStrategy;
    if (id === "endTpsBehavior") partial.endTpsBehavior = value as EndTpsBehavior;
    try {
      await settings.update(partial);
    } catch (error) {
      ctx.ui.notify(`[pi-tps-status] Could not save settings: ${(error as Error).message}`, "error");
      return;
    }
    notifyValidationErrors(ctx, settings.validationErrors);
    this.meter.configure(settings.config);
    this.renderer.update(ctx);
  }

  private buildItems(config: TokenSpeedConfig): SettingItem[] {
    return [
      {
        id: "display",
        label: "Display mode",
        description: "What the status bar shows",
        currentValue: config.display,
        values: [...DISPLAY_MODES],
      },
      {
        id: "useProviderTokens",
        label: "Use provider tokens",
        description: "Prefer the provider's exact token counts when reported",
        currentValue: config.useProviderTokens ? "on" : "off",
        values: [...TOGGLE_VALUES],
      },
      {
        id: "countStrategy",
        label: "Count strategy",
        description: "Token counting: provider-only, chars/4 estimate, or per chunk",
        currentValue: config.countStrategy,
        values: [...COUNT_STRATEGIES],
      },
      {
        id: "endTpsBehavior",
        label: "End-of-stream TPS",
        description: "What to show after streaming stops",
        currentValue: config.endTpsBehavior,
        values: [...END_BEHAVIORS],
      },
    ];
  }
}

class TpsEvents {
  constructor(
    private readonly meter: TpsMeter,
    private readonly renderer: StatusRenderer,
  ) {}

  async handleSessionStart(ctx: ExtensionContext): Promise<void> {
    await settings.initialize();
    notifyValidationErrors(ctx, settings.validationErrors);
    this.meter.configure(settings.config);
    this.renderer.initialize(ctx);
  }

  handleSessionShutdown(): void {
    this.meter.stop();
  }

  handleMessageStart(event: MessageStartEvent): void {
    if (event.message.role === "user") {
      this.meter.startTtft();
    } else if (event.message.role === "assistant") {
      this.meter.startMessage();
    }
  }

  handleMessageEnd(event: MessageEndEvent, ctx: ExtensionContext): void {
    if (event.message.role === "assistant") {
      this.meter.recordFinalUsage(event.message.usage?.output);
      this.renderer.update(ctx);
    }
  }

  handleMessageUpdate(event: MessageUpdateEvent, ctx: ExtensionContext): void {
    const ev = event.assistantMessageEvent;
    if (ev.type === "text_start" || ev.type === "thinking_start" || ev.type === "toolcall_start") {
      this.meter.stopTtft();
      this.meter.start();
      return;
    }
    if (ev.type === "text_delta" || ev.type === "thinking_delta" || ev.type === "toolcall_delta") {
      this.meter.recordDelta(ev.delta);
      this.renderer.update(ctx);
      return;
    }
  }

  private activeToolExecutions = 0;

  handleToolExecutionStart(): void {
    this.activeToolExecutions++;
    if (this.activeToolExecutions === 1) this.meter.pause();
  }

  handleToolExecutionEnd(): void {
    this.activeToolExecutions = Math.max(0, this.activeToolExecutions - 1);
    if (this.activeToolExecutions === 0) this.meter.resume();
  }

  handleAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): void {
    this.meter.stop();
    let outputTokens = 0;
    for (const message of event.messages) {
      if (message.role === "assistant") {
        outputTokens += message.usage?.output ?? 0;
      }
    }
    this.meter.reconcile(outputTokens);
    this.renderer.update(ctx);
  }
}

export default function (pi: ExtensionAPI) {
  const meter = new TpsMeter();
  const renderer = new StatusRenderer(meter);
  const commands = new TpsCommands(meter, renderer);
  const events = new TpsEvents(meter, renderer);

  pi.registerCommand("tps", {
    description:
      "Configure the TPS status widget: display mode, token counting, and end-of-stream behavior",
    handler: (_, ctx: ExtensionCommandContext) => commands.run(ctx),
  });

  pi.on("session_start", (_, ctx: ExtensionContext) => events.handleSessionStart(ctx));
  pi.on("session_shutdown", () => events.handleSessionShutdown());
  pi.on("message_start", (event) => events.handleMessageStart(event));
  pi.on("message_end", (event, ctx: ExtensionContext) => events.handleMessageEnd(event, ctx));
  pi.on("message_update", (event, ctx: ExtensionContext) =>
    events.handleMessageUpdate(event, ctx),
  );
  pi.on("tool_execution_start", () => events.handleToolExecutionStart());
  pi.on("tool_execution_end", () => events.handleToolExecutionEnd());
  pi.on("agent_end", (event: AgentEndEvent, ctx: ExtensionContext) =>
    events.handleAgentEnd(event, ctx),
  );
}
