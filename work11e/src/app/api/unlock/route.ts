import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, getAccessKey, getSessionSalt, hashAccessKey } from "@/lib/auth";

export async function POST(request: Request) {
  const configuredKey = getAccessKey();

  if (!configuredKey) {
    return NextResponse.json({ ok: true, message: "Access key is not configured." });
  }

  const body = (await request.json().catch(() => null)) as { accessKey?: string } | null;
  const submittedKey = body?.accessKey?.trim();

  if (!submittedKey || submittedKey !== configuredKey) {
    return NextResponse.json({ ok: false, message: "Invalid Raven passcode." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE_NAME, await hashAccessKey(configuredKey, getSessionSalt()), {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30
  });

  return response;
}
