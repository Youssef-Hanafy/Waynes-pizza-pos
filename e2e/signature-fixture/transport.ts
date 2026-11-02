export async function readCustomerDisplay() { return (await fetch("/fixture/read")).json(); }
export async function listCustomerDisplays() { return ["Front"]; }
export async function respondToCustomerDisplay(_key: string, answer: unknown) {
  const response = await fetch("/fixture/respond", { method: "POST", body: JSON.stringify(answer) });
  if (!response.ok) throw Error("Send failed");
}
export async function publishCustomerDisplay() { return { response: {}, screen_online: true }; }
