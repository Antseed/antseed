import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fit, type Room} from './fit.ts';
import {RIG, TUNING} from './rig.ts';

const [bx0, by0, bx1, by1] = RIG.bounds;
const top = (room: Room, w: number) => room.H - w * (1 - TUNING.crop) * (by1 - by0) / (bx1 - bx0);
const left = (room: Room, {w, right}: {w: number; right: number}) => room.W - right - w;

// boxes measured on the page, in card px, with the announcement bar open
const DESK_1440: Room = {W: 1404, H: 757, title: {left: 330, top: 101, right: 1074, bottom: 271}, install: {left: 402, top: 297, right: 1002, bottom: 449}};
const DESK_1280: Room = {W: 1248, H: 657, title: {left: 237, top: 97, right: 1010, bottom: 267}, install: {left: 324, top: 293, right: 924, bottom: 445}};
const TABLET_820: Room = {W: 788, H: 1037, title: {left: 95, top: 162, right: 693, bottom: 332}, install: {left: 94, top: 358, right: 694, bottom: 510}};
const PHONE_360: Room = {W: 328, H: 520, title: {left: 16, top: 90, right: 312, bottom: 264}, install: null};

test('on a wide screen it keeps its full size beside the install block', () => {
  const f = fit({...DESK_1440, H: 900});
  assert.equal(f.w, TUNING.width);
  assert.ok(f.shows);
});

test('its antennae never reach into the title (1280 × 800)', () => {
  const f = fit(DESK_1280);
  assert.ok(f.shows);
  assert.ok(left(DESK_1280, f) < DESK_1280.title.right, 'under the title');
  assert.ok(top(DESK_1280, f.w) >= DESK_1280.title.bottom - 0.01, 'below it');
});

test('on a portrait tablet it sits under the text, near full size', () => {
  const f = fit(TABLET_820);
  assert.ok(f.shows && f.w > TUNING.width * 0.95);
  assert.ok(top(TABLET_820, f.w) >= TABLET_820.install!.bottom);
});

test('on a phone it shows under the title, at most 60% of the card wide', () => {
  const f = fit(PHONE_360);
  assert.ok(f.shows);
  assert.ok(f.w <= PHONE_360.W * TUNING.narrowShare);
  assert.ok(top(PHONE_360, f.w) >= PHONE_360.title.bottom);
  assert.ok(left(PHONE_360, f) > 0);
});

test('with no room under a wide title it hides rather than shrink to a speck', () => {
  assert.equal(fit({...PHONE_360, H: 300}).shows, false);
});

test('on a landscape tablet (1024 × 768) it shows, a third past the right edge beside the install block', () => {
  const TABLET_1024: Room = {W: 992, H: 625, title: {left: 109, top: 84, right: 883, bottom: 254}, install: {left: 196, top: 280, right: 796, bottom: 432}};
  const f = fit(TABLET_1024);
  assert.ok(f.shows);
  assert.ok(left(TABLET_1024, f) >= TABLET_1024.install!.right + 16, 'clear of the install block');
  assert.ok(top(TABLET_1024, f.w) >= TABLET_1024.title.bottom, 'below the title');
});
