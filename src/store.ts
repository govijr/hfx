import { useSyncExternalStore } from "react";
import type { Hardware, Modality } from "./hardware";
import type { HubModel, Variant } from "./hub";
import type { LocalModel } from "./library";

export type Item =
  | { kind: "banner"; id: number }
  | { kind: "user"; id: number; text: string; images: string[] }
  | { kind: "assistant"; id: number; text: string; thinking: string; streaming: boolean; stats?: string }
  | { kind: "note"; id: number; text: string; tone: "muted" | "error" | "ok" | "accent" }
  | { kind: "help"; id: number }
  | { kind: "download"; id: number; model: string; variant: string; done: number; total: number; speed: number; state: "running" | "done" | "error" | "cancelled" }
  | { kind: "gen"; id: number; prompt: string; modality: "image" | "video"; step: number; total: number; path?: string; poster?: string; seconds?: number; failed?: boolean };

export interface HubRow {
  kind: "hub";
  model: HubModel;
  variants?: Variant[] | "loading" | string;
  variantIndex: number;
}
export interface LocalRow {
  kind: "local";
  model: LocalModel;
}
export type Row = HubRow | LocalRow;

export interface Picker {
  title: string;
  rows: Row[];
  index: number;
  loading: boolean;
  error?: string;
}

export interface Active {
  model: LocalModel;
  runtime: string;
}

export interface Busy {
  label: string;
  detail?: string;
  startedAt: number;
  cancellable: boolean;
}

export interface State {
  hw: Hardware;
  rem: number;
  items: Item[];
  picker: Picker | null;
  busy: Busy | null;
  active: Active | null;
  input: string;
  attachments: string[];
  history: string[];
  historyIndex: number;
  slashIndex: number;
  filter: Modality | null;
}

let state: State;
const listeners = new Set<() => void>();
let nextId = 1;
export const newId = () => nextId++;

export function initStore(initial: State) {
  state = initial;
}
export const getState = () => state;
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const l of listeners) l();
}
export function useAppState<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => select(state),
  );
}

export function pushItem(item: Item): number {
  setState((s) => ({ items: [...s.items, item] }));
  return item.id;
}
export function patchItem<K extends Item["kind"]>(id: number, patch: Partial<Extract<Item, { kind: K }>>) {
  setState((s) => ({ items: s.items.map((it) => (it.id === id ? ({ ...it, ...patch } as Item) : it)) }));
}
export const note = (text: string, tone: "muted" | "error" | "ok" | "accent" = "muted") =>
  pushItem({ kind: "note", id: newId(), text, tone });
