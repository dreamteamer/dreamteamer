/**
 * Edit distance, capped — enough to turn `--fliter` into "did you mean --filter?", and to refuse to
 * guess at anything further away than a typo.
 */
export function nearest(word: string, candidates: string[]): string | null {
  const distance = (c: string): number => {
    let prev = [...Array(word.length + 1).keys()]
    for (let i = 1; i <= c.length; i++) {
      const row = [i]
      for (let j = 1; j <= word.length; j++)
        row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (c[i - 1] === word[j - 1] ? 0 : 1))
      prev = row
    }
    return prev[word.length]
  }
  const cap = Math.min(3, Math.ceil(word.length / 2))
  return (
    candidates
      .map((c): [string, number] => [c, distance(c)])
      .filter(([, n]) => n <= cap)
      .sort((a, b) => a[1] - b[1])[0]?.[0] ?? null
  )
}
