import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { TxStepper, type TxStep } from "./OpenPosition.js";

export interface StepperRequest {
  steps: TxStep[];
  title?: string;
  onAllDone?: (lastHash?: `0x${string}`) => void;
  onClose?: () => void;
}

const StepperCtx = createContext<(req: StepperRequest) => void>(() => {
  throw new Error("useStepper must be used within <StepperProvider>");
});

/** Start a guided multi-tx flow that runs in an app-root overlay. Returns a function you
 * call with the steps; the modal it opens is NOT a child of your component, so it survives
 * your component unmounting (a position flipping open→closed, a route change) mid-run. */
export const useStepper = () => useContext(StepperCtx);

/** Hosts the guided TxStepper once, at the app root. Before this, the stepper lived inside
 * PositionActions, which unmounts the instant a position flips open→closed — silently
 * killing the approve+swap legs of a v3 zap-out (position closed, tokens never swapped,
 * modal vanished as if done). Hosted here it can't be torn down by the screen underneath.
 * `key` per run so a fresh run resets the step statuses. */
export function StepperProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(StepperRequest & { _id: number }) | null>(null);
  const nonce = useRef(0);
  const run = useCallback((r: StepperRequest) => setReq({ ...r, _id: ++nonce.current }), []);
  return (
    <StepperCtx.Provider value={run}>
      {children}
      {req && (
        <TxStepper
          key={req._id}
          steps={req.steps}
          title={req.title}
          onAllDone={(h) => {
            setReq(null);
            req.onAllDone?.(h);
          }}
          onClose={() => {
            setReq(null);
            req.onClose?.();
          }}
        />
      )}
    </StepperCtx.Provider>
  );
}
