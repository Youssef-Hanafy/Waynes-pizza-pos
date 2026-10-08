"use server";

import { redirect } from "next/navigation";
import { persistHardwareSettings } from "./save";

const back = (message: string, key: "error" | "saved" = "error") => redirect(`/admin/hardware?${key}=${encodeURIComponent(message)}`);

/** Save Admin → Hardware (§28). Validated here, then in the database, then audited. */
export async function saveHardwareSettings(form: FormData) {
  const result = await persistHardwareSettings(form);
  back(result.message, result.key);
}
