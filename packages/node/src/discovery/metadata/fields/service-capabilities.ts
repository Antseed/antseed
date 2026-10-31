import type { ServiceCapabilities, ServiceCapabilityModality, VideoInputKind, VideoOptions } from "../../peer-metadata.js";
import { SERVICE_CAPABILITY_MODALITIES, VIDEO_INPUT_KINDS } from "../../peer-metadata.js";
import type { ProviderField } from "../field.js";
import { compareCodeUnits, type MetadataReader, type MetadataWriter, serviceMap } from "../wire.js";

// Presence bits for the per-service capability entry. A set bit means the
// field was announced (booleans distinguish "known false" from "unknown").
const CAP_HAS_CONTEXT_WINDOW = 1 << 0;
const CAP_HAS_MAX_OUTPUT_TOKENS = 1 << 1;
const CAP_HAS_INPUTS = 1 << 2;
const CAP_HAS_REASONING = 1 << 3;
const CAP_HAS_TOOL_USE = 1 << 4;
const CAP_HAS_STRUCTURED_OUTPUT = 1 << 5;
const CAP_HAS_OUTPUTS = 1 << 6;
const CAP_HAS_SUPPORTED_PARAMETERS = 1 << 7;
const CAP_PRESENCE_MASK = CAP_HAS_CONTEXT_WINDOW | CAP_HAS_MAX_OUTPUT_TOKENS | CAP_HAS_INPUTS
  | CAP_HAS_REASONING | CAP_HAS_TOOL_USE | CAP_HAS_STRUCTURED_OUTPUT
  | CAP_HAS_OUTPUTS | CAP_HAS_SUPPORTED_PARAMETERS;
const CAP_VAL_REASONING = 1 << 0;
const CAP_VAL_TOOL_USE = 1 << 1;
const CAP_VAL_STRUCTURED_OUTPUT = 1 << 2;
const CAP_VAL_VIDEO_OPTIONS = 1 << 3;
const CAP_VALUE_MASK = CAP_VAL_REASONING | CAP_VAL_TOOL_USE | CAP_VAL_STRUCTURED_OUTPUT
  | CAP_VAL_VIDEO_OPTIONS;
const CAP_MODALITY_MASK = (1 << SERVICE_CAPABILITY_MODALITIES.length) - 1;
const VIDEO_HAS_DURATIONS = 1 << 0;
const VIDEO_HAS_RESOLUTIONS = 1 << 1;
const VIDEO_HAS_ASPECT_RATIOS = 1 << 2;
const VIDEO_HAS_INPUTS = 1 << 3;
const VIDEO_HAS_REQUIRED_INPUTS = 1 << 4;
const VIDEO_HAS_AUDIO = 1 << 5;
const VIDEO_AUDIO = 1 << 6;
const VIDEO_OPTION_MASK = (1 << 7) - 1;
const VIDEO_INPUT_MASK = (1 << VIDEO_INPUT_KINDS.length) - 1;

function encodeModalityBits(modalities: ServiceCapabilityModality[]): number {
  let bits = 0;
  for (const modality of modalities) {
    const id = SERVICE_CAPABILITY_MODALITIES.indexOf(modality);
    if (id >= 0) bits |= 1 << id;
  }
  return bits;
}

function decodeModalityBits(bits: number, label: string): ServiceCapabilityModality[] {
  if (bits & ~CAP_MODALITY_MASK) {
    throw new Error(`Unknown service capability ${label} bits 0x${bits.toString(16)}`);
  }
  const modalities: ServiceCapabilityModality[] = [];
  for (let id = 0; id < SERVICE_CAPABILITY_MODALITIES.length; id += 1) {
    if (bits & (1 << id)) modalities.push(SERVICE_CAPABILITY_MODALITIES[id]!);
  }
  return modalities;
}

function encodeVideoInputs(inputs: VideoInputKind[]): number {
  return inputs.reduce((bits, input) => bits | (1 << VIDEO_INPUT_KINDS.indexOf(input)), 0);
}

function decodeVideoInputs(bits: number): VideoInputKind[] {
  if (bits & ~VIDEO_INPUT_MASK) throw new Error(`Unknown video input bits 0x${bits.toString(16)}`);
  return VIDEO_INPUT_KINDS.filter((_, id) => bits & (1 << id));
}

function encodeVideoOptions(writer: MetadataWriter, video: VideoOptions): void {
  let flags = 0;
  if (video.durationsSeconds) flags |= VIDEO_HAS_DURATIONS;
  if (video.resolutions) flags |= VIDEO_HAS_RESOLUTIONS;
  if (video.aspectRatios) flags |= VIDEO_HAS_ASPECT_RATIOS;
  if (video.inputs) flags |= VIDEO_HAS_INPUTS;
  if (video.requiredInputs) flags |= VIDEO_HAS_REQUIRED_INPUTS;
  if (video.audio !== undefined) flags |= VIDEO_HAS_AUDIO | (video.audio ? VIDEO_AUDIO : 0);
  writer.u8(flags);
  if (video.durationsSeconds) {
    writer.u8(video.durationsSeconds.length);
    for (const duration of video.durationsSeconds) writer.bytes(new Uint8Array([duration >> 8, duration & 0xff]));
  }
  for (const values of [video.resolutions, video.aspectRatios]) {
    if (!values) continue;
    writer.u8(values.length);
    for (const value of values) writer.utf8(value);
  }
  if (video.inputs) writer.u8(encodeVideoInputs(video.inputs));
  if (video.requiredInputs) writer.u8(encodeVideoInputs(video.requiredInputs));
}

function decodeVideoOptions(reader: MetadataReader): VideoOptions {
  const flags = reader.u8();
  if (flags & ~VIDEO_OPTION_MASK || (flags & VIDEO_AUDIO && !(flags & VIDEO_HAS_AUDIO))) throw new Error(`Unknown video option bits 0x${flags.toString(16)}`);
  const video: VideoOptions = {};
  if (flags & VIDEO_HAS_DURATIONS) {
    const count = reader.u8();
    const bytes = reader.bytes(count * 2);
    video.durationsSeconds = Array.from({ length: count }, (_, index) => (bytes[index * 2]! << 8) | bytes[index * 2 + 1]!);
  }
  for (const [flag, field] of [[VIDEO_HAS_RESOLUTIONS, "resolutions"], [VIDEO_HAS_ASPECT_RATIOS, "aspectRatios"]] as const) {
    if (!(flags & flag)) continue;
    const count = reader.u8();
    const values: string[] = [];
    for (let index = 0; index < count; index += 1) values.push(reader.utf8());
    video[field] = values;
  }
  for (const [flag, field] of [[VIDEO_HAS_INPUTS, "inputs"], [VIDEO_HAS_REQUIRED_INPUTS, "requiredInputs"]] as const) {
    if (!(flags & flag)) continue;
    video[field] = decodeVideoInputs(reader.u8());
  }
  if (flags & VIDEO_HAS_AUDIO) video.audio = (flags & VIDEO_AUDIO) !== 0;
  return video;
}

/**
 * [count:1|2] then [serviceLen:1][service:N][presence:1][contextWindow:4?][maxOutputTokens:4?]
 * [inputs:1?][outputs:1?][valueBits:1][parameterCount:1 + params?][videoOptions?]
 */
export const serviceCapabilitiesField: ProviderField = {
  key: "serviceCapabilities",
  encode(writer, provider, ctx) {
    // Code-unit sort, not localeCompare: buyers verify signatures by re-encoding
    // decoded metadata, so entry order must not depend on the verifier's locale.
    const entries = Object.entries(provider.serviceCapabilities ?? {}).sort(([a], [b]) => compareCodeUnits(a, b));
    writer.serviceEntryCount(entries.length, ctx.wideServiceCounts);
    for (const [service, caps] of entries) {
      writer.utf8(service);
      let presence = 0;
      if (caps.contextWindow !== undefined) presence |= CAP_HAS_CONTEXT_WINDOW;
      if (caps.maxOutputTokens !== undefined) presence |= CAP_HAS_MAX_OUTPUT_TOKENS;
      if (caps.inputs !== undefined) presence |= CAP_HAS_INPUTS;
      if (caps.outputs !== undefined) presence |= CAP_HAS_OUTPUTS;
      if (caps.reasoning !== undefined) presence |= CAP_HAS_REASONING;
      if (caps.toolUse !== undefined) presence |= CAP_HAS_TOOL_USE;
      if (caps.structuredOutput !== undefined) presence |= CAP_HAS_STRUCTURED_OUTPUT;
      if (caps.supportedParameters !== undefined) presence |= CAP_HAS_SUPPORTED_PARAMETERS;
      writer.u8(presence);
      if (caps.contextWindow !== undefined) writer.u32(caps.contextWindow);
      if (caps.maxOutputTokens !== undefined) writer.u32(caps.maxOutputTokens);
      if (caps.inputs !== undefined) writer.u8(encodeModalityBits(caps.inputs));
      if (caps.outputs !== undefined) writer.u8(encodeModalityBits(caps.outputs));
      let valueBits = 0;
      if (caps.reasoning === true) valueBits |= CAP_VAL_REASONING;
      if (caps.toolUse === true) valueBits |= CAP_VAL_TOOL_USE;
      if (caps.structuredOutput === true) valueBits |= CAP_VAL_STRUCTURED_OUTPUT;
      if (caps.video !== undefined) valueBits |= CAP_VAL_VIDEO_OPTIONS;
      writer.u8(valueBits);
      if (caps.supportedParameters !== undefined) {
        // Code-unit sort for the same reason as the entry sort above.
        const parameters = [...caps.supportedParameters].sort(compareCodeUnits);
        if (parameters.length > 255) {
          throw new Error(`Too many supported parameters (${parameters.length})`);
        }
        writer.u8(parameters.length);
        for (const parameter of parameters) writer.utf8(parameter);
      }
      if (caps.video !== undefined) encodeVideoOptions(writer, caps.video);
    }
  },
  decode(reader, provider, ctx) {
    const count = reader.serviceEntryCount(ctx.wideServiceCounts);
    const serviceCapabilities: Record<string, ServiceCapabilities> = serviceMap();
    for (let i = 0; i < count; i += 1) {
      const service = reader.utf8();
      const presence = reader.u8();
      if (presence & ~CAP_PRESENCE_MASK) {
        // Unknown bits would decode into a struct that re-encodes to different
        // bytes and fails signature verification anyway — reject explicitly so
        // additive extensions are forced through a metadata version bump.
        throw new Error(`Unknown service capability presence bits 0x${presence.toString(16)}`);
      }
      const caps: ServiceCapabilities = {};
      if (presence & CAP_HAS_CONTEXT_WINDOW) caps.contextWindow = reader.u32();
      if (presence & CAP_HAS_MAX_OUTPUT_TOKENS) caps.maxOutputTokens = reader.u32();
      if (presence & CAP_HAS_INPUTS) caps.inputs = decodeModalityBits(reader.u8(), "input");
      if (presence & CAP_HAS_OUTPUTS) caps.outputs = decodeModalityBits(reader.u8(), "output");
      const valueBits = reader.u8();
      if (valueBits & ~CAP_VALUE_MASK) {
        throw new Error(`Unknown service capability value bits 0x${valueBits.toString(16)}`);
      }
      if (presence & CAP_HAS_REASONING) caps.reasoning = (valueBits & CAP_VAL_REASONING) !== 0;
      if (presence & CAP_HAS_TOOL_USE) caps.toolUse = (valueBits & CAP_VAL_TOOL_USE) !== 0;
      if (presence & CAP_HAS_STRUCTURED_OUTPUT) caps.structuredOutput = (valueBits & CAP_VAL_STRUCTURED_OUTPUT) !== 0;
      if (presence & CAP_HAS_SUPPORTED_PARAMETERS) {
        const parameterCount = reader.u8();
        const parameters: string[] = [];
        for (let p = 0; p < parameterCount; p += 1) parameters.push(reader.utf8());
        caps.supportedParameters = parameters;
      }
      if (valueBits & CAP_VAL_VIDEO_OPTIONS) caps.video = decodeVideoOptions(reader);
      serviceCapabilities[service] = caps;
    }
    if (Object.keys(serviceCapabilities).length > 0) provider.serviceCapabilities = serviceCapabilities;
  },
};
