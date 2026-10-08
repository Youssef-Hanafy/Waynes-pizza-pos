import { NextResponse } from "next/server";
import { persistHardwareSettings } from "../save";

/** A stable progressive-enhancement endpoint for counter tablets. */
export async function POST(request: Request) {
  const result = await persistHardwareSettings(await request.formData());
  const destination = new URL("/admin/hardware", request.url);
  destination.searchParams.set(result.key, result.message);
  return NextResponse.redirect(destination, 303);
}
