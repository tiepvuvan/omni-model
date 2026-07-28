import { Menu } from "@base-ui-components/react/menu";
import deleteIcon from "../../assets/delete.svg";
import { cx, ThemedIcon } from "../ui/primitives";

/**
 * The single icon button the design puts in a match-rule header.
 *
 * A rule needs more than one action — reorder, probe, remove — and the design
 * draws one 28px button. A menu is how both are true: the header stays as drawn,
 * and nothing an operator needs is missing. Reordering in particular cannot be
 * dropped, because order *is* meaning here: the first matching rule wins.
 */
export function RuleMenu({
  ruleId,
  canMoveUp,
  canMoveDown,
  probing,
  onMoveUp,
  onMoveDown,
  onTest,
  onRemove,
}: {
  ruleId: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  probing: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  const item =
    "flex w-full cursor-default items-center rounded-[6px] px-[8px] py-[6px] text-left type-copy-14 " +
    "text-foreground-primary data-[highlighted]:bg-item-selection data-[disabled]:opacity-40";

  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Actions for ${ruleId}`}
        className="flex size-[28px] shrink-0 items-center justify-center rounded-[var(--radius-pill)] border border-solid border-border bg-button-background hover:bg-item-selection"
      >
        <ThemedIcon src={deleteIcon} className="size-[14px]" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={4} align="end" className="z-50">
          <Menu.Popup className="min-w-[12rem] rounded-[var(--radius-field)] border border-solid border-border bg-menu-background p-[4px] shadow-lg">
            <Menu.Item className={item} disabled={!canMoveUp} onClick={onMoveUp}>
              Move up
            </Menu.Item>
            <Menu.Item className={item} disabled={!canMoveDown} onClick={onMoveDown}>
              Move down
            </Menu.Item>
            <Menu.Item className={item} disabled={probing} onClick={onTest}>
              {probing ? "Testing…" : "Test upstream"}
            </Menu.Item>
            <Menu.Separator className="my-[4px] h-px bg-border" />
            <Menu.Item className={cx(item, "text-destructive")} onClick={onRemove}>
              Remove rule
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
