import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginText,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { View } from "react-native";
import { type ExchangeStatus, getThread } from "../shared/thread";
import { AskBox } from "./ask-box";
import { onAsked } from "./asked";
import { label } from "./i18n";
import { ThreadView } from "./thread-view";

export const SIDE_QUESTION_ICON = "MessageCircleQuestionMark";
const POLL_MS = 1_000;

interface Pill {
  registration: PluginButtonRegistration<PluginText>;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PillManager {
  /** Shows the agent's pill above its composer, or refreshes it when it is already there. */
  show(workspaceId: string, agentId: string): void;
  dispose(): void;
}

/**
 * A pill above the composer stands in for Claude Code's overlay: it reports the answer's progress
 * and opens the thread in a popover, or a bottom sheet on compact layouts. It shows on every
 * layout, since it is the one surface every app draws. A pill cannot open itself, so where no
 * panel opens beside the chat the answer is one tap away rather than on screen.
 */
export function createPillManager(client: PluginClientContext): PillManager {
  const pills = new Map<string, Pill>();
  let disposed = false;

  function hide(agentId: string): void {
    const pill = pills.get(agentId);
    if (!pill) return;
    pills.delete(agentId);
    if (pill.timer) clearTimeout(pill.timer);
    pill.registration.remove();
  }

  const Sheet = createSheet(hide);

  function refresh(agentId: string): void {
    const pill = pills.get(agentId);
    if (!pill) return;
    if (pill.timer) clearTimeout(pill.timer);
    pill.timer = null;
    client.rpc(getThread, { agentId, focusId: null }).then(
      (thread) => {
        if (pills.get(agentId) !== pill) return;
        pill.registration.update({ label: labelFor(thread.focus?.status ?? null) });
        const answering = thread.exchanges.some((exchange) => exchange.status === "answering");
        if (answering) pill.timer = setTimeout(() => refresh(agentId), POLL_MS);
      },
      () => {
        // The host may be reconnecting; try again, more slowly.
        if (pills.get(agentId) === pill) pill.timer = setTimeout(() => refresh(agentId), POLL_MS * 5);
      },
    );
  }

  // A question asked from an ask box restarts the pill's progress updates.
  const stopListening = onAsked((agentId) => refresh(agentId));

  return {
    show(workspaceId, agentId) {
      if (disposed) return;
      if (!pills.has(agentId)) {
        const registration = client.addComposerPill({
          id: "side-question",
          workspaceId,
          agentId,
          button: {
            title: label("pill.title"),
            icon: SIDE_QUESTION_ICON,
            label: labelFor("answering"),
            behavior: { kind: "popover", Content: Sheet },
          },
        });
        pills.set(agentId, { registration, timer: null });
      }
      refresh(agentId);
    },
    dispose() {
      disposed = true;
      stopListening();
      for (const agentId of Array.from(pills.keys())) hide(agentId);
    },
  };
}

function createSheet(hide: (agentId: string) => void): ComponentType<PluginButtonContentProps> {
  return function SideQuestionSheet(props) {
    const agentId = props.context === "agent" ? props.agentId : null;
    if (agentId === null) return null;
    return (
      <View style={{ gap: 14 }}>
        <ThreadView
          agentId={agentId}
          theme={props.theme}
          onDismiss={() => {
            props.close();
            hide(agentId);
          }}
        />
        <AskBox agentId={agentId} theme={props.theme} />
      </View>
    );
  };
}

function labelFor(status: ExchangeStatus | null): PluginText {
  switch (status) {
    case "answering":
      return label("pill.answering");
    case "answered":
      return label("pill.answered");
    case "failed":
      return label("pill.failed");
    case "stopped":
      return label("pill.stopped");
    case null:
      return label("pill.idle");
  }
}
