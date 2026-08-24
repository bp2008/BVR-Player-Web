/** Minimal growable typed-array list; avoids boxing millions of frame records. */
export class Growable {
  constructor (Ctor, capacity = 1024) {
    this.Ctor = Ctor
    this.data = new Ctor(capacity)
    this.length = 0
  }

  push (v) {
    if (this.length === this.data.length) {
      const next = new this.Ctor(this.data.length * 2)
      next.set(this.data)
      this.data = next
    }
    this.data[this.length++] = v
  }

  /** Returns a right-sized copy. */
  toTyped () {
    return this.data.slice(0, this.length)
  }
}
