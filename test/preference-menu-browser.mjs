// Operate the actual host Menu, not localStorage or a simulated select.
const labels = { recent: 'Current subscription only', hidden: 'Hidden', used: 'Used (default)', remaining: 'Remaining', text: 'Text percentages', compact: 'Compact quota bars' }
export async function choosePreference(trigger, value) {
  await trigger.click()
  await trigger.page().getByRole('menuitem', { name: labels[value], exact: true }).click()
}
export async function preferenceValue(trigger) {
  const text = (await trigger.innerText()).trim()
  return Object.keys(labels).find(key => labels[key] === text)
}
