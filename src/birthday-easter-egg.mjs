const shanghaiDateParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "numeric",
  day: "numeric"
});

function dateParts(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const values = Object.fromEntries(
    shanghaiDateParts.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return values;
}

export function containsBirthdayWish(message) {
  return String(message || "").normalize("NFKC").replace(/\s+/g, "").includes("生日快乐");
}

export function birthdaySignalActive(now = new Date()) {
  const date = dateParts(now);
  return Boolean(date && date.month === 8 && date.day === 16);
}

export function birthdayTicketFor(message, messageId, now = new Date()) {
  const date = dateParts(now);
  if (!date || !birthdaySignalActive(now) || !containsBirthdayWish(message)) return null;
  const id = Math.max(0, Math.trunc(Number(messageId) || 0));
  return {
    code: `${date.year}0816-${String(id).padStart(6, "0")}`,
    date: `${date.year}-08-16`
  };
}
