import { SegmentedControl } from "@/components/ui/segmented-control";
import { type SessionsShow, useSessionsShow } from "@/lib/sessions-show";
import { cn } from "@/lib/utils";

const OPTIONS = [
  {
    value: "mine",
    label: "Mine",
    tooltip: "Sessions you started, plus sessions shared with you",
  },
  {
    value: "all",
    label: "All",
    tooltip: "Also workflow, schedule, and system runs started for you",
  },
] as const;

/** The Mine / All view of the session list. It needs a picked user: with none, every session shows. */
export function ShowToggle({ phone = false }: { phone?: boolean }) {
  const [show, setShow] = useSessionsShow();
  return (
    <div className={cn("shrink-0", phone ? "px-4 pb-2" : "px-2 pb-1")}>
      <SegmentedControl<SessionsShow>
        aria-label="Sessions to show"
        size="sm"
        value={show}
        onValueChange={setShow}
        options={OPTIONS}
      />
    </div>
  );
}
