import { Menu } from "@base-ui-components/react/menu";
import arrowDownIcon from "../../assets/arrow-down.svg";
import vendorAnthropic from "../../assets/vendor-anthropic.svg";
import vendorGoogle from "../../assets/vendor-google.svg";
import vendorOpenAi from "../../assets/vendor-openai.svg";
import vendorOpenAiCompatible from "../../assets/vendor-openai-compatible.svg";
import { cx } from "../ui/primitives";

/** The glyph for each provider type. One SVG, drawn at 24px or 16px. */
export const VENDOR_ICONS: Record<string, string> = {
  openai: vendorOpenAi,
  anthropic: vendorAnthropic,
  "openai-compatible": vendorOpenAiCompatible,
  google: vendorGoogle,
};

/**
 * How each provider type is named.
 *
 * Taken from the menu in the file rather than the card header: the header says
 * "Open AI" and the menu says "OpenAI", and the menu is the one that is right.
 */
export const VENDOR_TITLES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  "openai-compatible": "OpenAI compatible",
  google: "Gemini",
};

/** The design's order, which is not alphabetical. */
const ORDER = ["openai", "anthropic", "openai-compatible", "google"] as const;

/** Types the registry has, in the design's order, then anything an embedder added. */
function ordered(available: readonly string[]): string[] {
  return [
    ...ORDER.filter((type) => available.includes(type)),
    ...available.filter((type) => !ORDER.includes(type as (typeof ORDER)[number])),
  ];
}

/** A vendor mark, or a monogram tile for a provider the design has no glyph for. */
export function VendorIcon({ type, size }: { type: string; size: 16 | 24 }) {
  const icon = VENDOR_ICONS[type];
  const box = size === 24 ? "size-[24px]" : "size-[16px]";
  if (icon === undefined) {
    return (
      <span
        aria-hidden
        className={cx(
          box,
          "flex shrink-0 items-center justify-center rounded-[6px] bg-item-selection type-strong-12 text-foreground-secondary",
        )}
      >
        {(VENDOR_TITLES[type] ?? type).charAt(0).toUpperCase()}
      </span>
    );
  }
  return <img src={icon} alt="" aria-hidden className={cx(box, "shrink-0")} />;
}

/**
 * The provider, chosen from the card's own header.
 *
 * The design puts the name and a small arrow where the title goes: a provider *is*
 * the card's identity, so changing it is changing what the card is rather than
 * editing a field inside it. It also means the choice is always one click away
 * instead of behind an edit button.
 *
 * Base UI's menu supplies the roles, focus handling and dismissal; the popup is
 * the design's — 24px radius, 6px padding, `pl-8 pr-10 py-8` items with a 16px
 * mark and a `Copy 14` label.
 */
export function ProviderPicker({
  available,
  value,
  onChange,
}: {
  /** Types the registry actually has, from `GET /meta`. */
  available: readonly string[];
  value: string;
  onChange: (type: string) => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`Provider: ${VENDOR_TITLES[value] ?? value}. Change it`}
        className="flex items-center gap-[6px] rounded-[6px] type-strong-14 text-foreground-primary hover:opacity-70"
      >
        {VENDOR_TITLES[value] ?? value}
        <img src={arrowDownIcon} alt="" aria-hidden className="size-[12px] shrink-0" />
      </Menu.Trigger>

      <Menu.Portal>
        <Menu.Positioner sideOffset={6} align="start" className="z-50">
          <Menu.Popup
            className={cx(
              "flex min-w-[220px] flex-col rounded-[24px] border border-solid border-border",
              "bg-menu-background p-[6px] shadow-[0px_2px_8px_rgba(0,0,0,0.06)]",
            )}
          >
            {ordered(available).map((type) => (
              <Menu.Item
                key={type}
                onClick={() => onChange(type)}
                className={cx(
                  "flex w-full cursor-default items-center gap-[8px] rounded-[18px] py-[8px] pl-[8px] pr-[10px]",
                  "type-copy-14 text-foreground-primary data-[highlighted]:bg-item-selection",
                  type === value && "bg-item-selection",
                )}
              >
                <VendorIcon type={type} size={16} />
                {VENDOR_TITLES[type] ?? type}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
