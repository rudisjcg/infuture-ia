import "i18next";
import type { Messages } from "@infuture/i18n";

// Makes t("...") type-checked against the English catalog: a typo in a key fails the build.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: Messages };
  }
}
