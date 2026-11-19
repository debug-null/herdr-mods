// @ts-check
// Hands herdr desktop's live theme colors to the live view (a terminal can't ask for them).
import { View, div } from "gpui-kit";
import { exec, props, closeOverlay, theme, settings } from "herdr";

const BIN = "/Users/user/.config/herdr/plugins/github/herdr-web-browser-c3ad05caf350/target/release/herdr-web-browser";

export default class Theme extends View {
  init(_props, cx) {
    cx.spawn(async (_cx) => {
      try {
        const s = settings();
        await exec(BIN, ["theme-sync", JSON.stringify({ ...theme(), dark: s ? s.dark : true })]).catch(() => null);
      } finally {
        closeOverlay(props().overlay);
      }
    });
  }

  render(_cx) {
    return div();
  }
}
