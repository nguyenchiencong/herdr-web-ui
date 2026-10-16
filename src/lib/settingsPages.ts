import { Bell, Gauge, Info, Keyboard, Mic, Monitor, MessageSquare, Palette, Plug, Smartphone, SquareTerminal, type LucideIcon } from "lucide-react";

import type { SettingsPageId } from "./paletteSettings.ts";

/**
 * The settings pages in the order the list shows them: what is looked at first, then what is set
 * once. Kept out of the dialog's module, so the command palette lists them without loading it.
 */
export const PAGES: readonly { id: SettingsPageId; icon: LucideIcon }[] = [
  { id: "appearance", icon: Palette },
  { id: "chat", icon: MessageSquare },
  { id: "terminal", icon: SquareTerminal },
  { id: "alerts", icon: Bell },
  { id: "voice", icon: Mic },
  { id: "usage", icon: Gauge },
  { id: "shortcuts", icon: Keyboard },
  { id: "devices", icon: Smartphone },
  { id: "remote", icon: Monitor },
  { id: "integrations", icon: Plug },
  { id: "about", icon: Info },
];
