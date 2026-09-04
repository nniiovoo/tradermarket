// The global live/upcoming schedule (P1).
//
// Rooms are grouped by the state the indexer derived from chain. A room that
// does not exist is never listed, and "live" means the chain says live — not
// that a marketing surface would like it to be.

const LIVE = new Set(["live"]);
const UPCOMING = new Set(["draft", "armed"]);
const RECENT = new Set(["closing", "settling", "final", "invalid"]);

export class Schedule {
  /**
   * @param options.roomId  legacy single-room scope
   * @param options.roomIds every room this process can actually serve
   *
   * Rooms are discovered from the factory, but only the configured room's slots
   * are indexed. Listing the others published fabricated zero slot counts and a
   * route that 404s — an entry that looks like a programme and is not one.
   */
  constructor({ store, roomId = null, roomIds = null }) {
    this.store = store;
    const configured = roomIds ?? (roomId ? [roomId] : null);
    this.roomIds = configured ? new Set(configured) : null;
  }

  _entry(room) {
    const slots = this.store.listSlots(room.room_id);
    const open = slots.filter((slot) => slot.state === "open" || slot.state === "awaiting-liquidity");
    const headline = slots.find((slot) => slot.slot_index === 0) ?? null;
    return {
      room_id: room.room_id,
      state: room.state,
      // Stable and shareable: the same URL always reaches the same room.
      route: `/room/${room.room_id}`,
      headline_question: headline?.question ?? null,
      slots: slots.length,
      open_slots: open.length,
      settled_slots: slots.filter((slot) => slot.state === "final" || slot.state === "invalid").length,
      closed_source_seq:
        room.closed_source_seq === undefined || room.closed_source_seq === null
          ? null
          : String(room.closed_source_seq),
      block_number: room.block_number ?? null,
    };
  }

  /** Rooms whose state this process actually indexes. */
  _servable() {
    const rooms = this.store.listRooms ? this.store.listRooms() : [...this.store.rooms.values()];
    return this.roomIds ? rooms.filter((room) => this.roomIds.has(room.room_id)) : rooms;
  }

  list() {
    const rooms = this._servable();
    if (rooms.length === 0) {
      return {
        live: [],
        upcoming: [],
        recent: [],
        empty_reason:
          "No room has been created yet. Live and upcoming sessions appear here once a Live Room is deployed.",
      };
    }
    const group = (predicate) =>
      rooms.filter((room) => predicate.has(room.state)).map((room) => this._entry(room));
    return {
      live: group(LIVE),
      upcoming: group(UPCOMING),
      recent: group(RECENT).sort((a, b) => (b.block_number ?? 0) - (a.block_number ?? 0)),
      empty_reason: null,
    };
  }
}
