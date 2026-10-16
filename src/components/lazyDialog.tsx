import { lazy, Suspense, useLayoutEffect, type ComponentType, type ReactElement } from "react";

import { lazyChunk } from "../lib/lazyChunk.ts";
import { RenderBoundary } from "./RenderBoundary.tsx";

export interface LazyDialog<Props extends object> {
  (props: Props): ReactElement;
  /** Starts fetching the code without rendering it; a failed fetch is told, as a render's would be, and nothing is thrown. */
  preload(): void;
}

/**
 * A component whose code is a chunk of its own, fetched the first time it renders or is preloaded.
 * Suspense does not catch a rejected import, so a boundary local to the component does: it draws
 * nothing for its chunk's failure (lazyChunk has told the app, which offers a reload) and rethrows any
 * other render error, which reaches the app's crash screen as it would without lazy loading. While the
 * chunk is still arriving, focus is released, so a key typed then reaches no field: the terminal would
 * otherwise take it as input to its pane.
 */
export function lazyDialog<Props extends object>(load: () => Promise<ComponentType<Props>>): LazyDialog<Props> {
  let arrived = false;
  let failure: { error: unknown } | null = null;
  const fetchOnce = lazyChunk(() => load().then(
    (component) => {
      arrived = true;
      return component;
    },
    (error: unknown) => {
      failure = { error };
      throw error;
    },
  ));
  const Chunk = lazy(async () => ({ default: await fetchOnce() }));
  const Dialog = (props: Props): ReactElement => {
    useLayoutEffect(() => {
      if (!arrived) releaseFocus();
    }, []);
    return (
      <RenderBoundary resetKey={null} fallback={(_retry, error) => drawNothingForLoadFailure(error, failure)}>
        <Suspense fallback={null}>
          <Chunk {...props} />
        </Suspense>
      </RenderBoundary>
    );
  };
  return Object.assign(Dialog, {
    preload: () => {
      void fetchOnce().catch(() => undefined);
    },
  });
}

/** What a dialog's boundary draws for `error`: nothing when the chunk is what failed, otherwise the error is rethrown. */
export function drawNothingForLoadFailure(error: unknown, failure: { error: unknown } | null): null {
  if (failure !== null && failure.error === error) return null;
  throw error;
}

/** Takes the focus off whatever holds it, so a key typed now reaches no field. */
function releaseFocus(): void {
  (document.activeElement as HTMLElement | null)?.blur();
}
