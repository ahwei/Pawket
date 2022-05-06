export function nameOmit(name: string, ellipsis = "...", length = 10, uppercase = true): string {
  let nameRes = "";
  if (!name) return nameRes;
  if (name.length <= length + ellipsis.length) {
    nameRes = name;
  } else {
    nameRes = name.slice(0, length) + ellipsis;
  }
  if (uppercase) return nameRes.toUpperCase();
  return nameRes;
}

export default { nameOmit };
