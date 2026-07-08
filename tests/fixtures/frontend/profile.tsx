export function Profile({ user }: { user: any }) {
  const { phoneNumber: phone } = user;          // alias — MUST be caught via source key
  return <div title={user.phoneNumber}>{phone}</div>;  // property access — caught
}
