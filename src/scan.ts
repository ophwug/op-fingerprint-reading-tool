import {
  findCalibrationMessages,
  findDeviceType,
  findFingerprintLogMessages,
  type CalibrationMessage,
  type CarParamsMessage,
  type DeviceType,
  type FingerprintLogMessages,
  type InitDataMessage,
  type OnroadEventMessage,
} from "./capnp";
import {
  HARDCODED_FP_BRANCH_INDEX_URL,
  HARDCODED_FP_REPO_URL,
  OPENPILOT_FINGERPRINTING_URL,
  OPENPILOT_NIGHTLY_DEV_INSTALLER_URL,
  SUNNYLINK_URL,
  SUNNYPILOT_RELEASE_MICI_INSTALLER_URL,
  SUNNYPILOT_URL,
  SUNNYPILOT_VEHICLE_SETTINGS_URL,
} from "./constants";
import { decompressLog } from "./decompress";
import { isInvalidCalibration } from "./format";
import {
  fetchRouteFiles,
  fetchRouteInfo,
  logSourceLabel,
  orderedLogUrls,
  orderedQcameraUrls,
  parseRouteInput,
  segmentFromUrl,
  type RouteInfo,
} from "./routes";

export interface ScanProgress {
  phase: "metadata" | "download" | "decode" | "done";
  message: string;
  current?: number;
  total?: number;
}

export interface CalibrationScanResult {
  routeName: string;
  routeInfo: RouteInfo | null;
  logUrl: string | null;
  logSource: "qlogs" | "rlogs";
  segment: number | null;
  message: CalibrationMessage | null;
  previousValid: CalibrationScanMessage | null;
  qcameraPreview: QcameraPreviewSource | null;
  readFailures: LogReadFailure[];
  scannedSegments: number;
  totalSegments: number;
  scanMode: "quick" | "full";
  resultType: "invalid" | "valid" | "incomplete";
  reason: "status-invalid" | "outside-current-limits" | "no-invalid-found" | "first-valid" | "scan-incomplete";
}

export interface QcameraPreviewSource {
  logUrl: string;
  segment: number;
  reason: "early-route" | "invalid-segment" | "unreadable-segment";
}

export interface CalibrationScanMessage {
  logUrl: string;
  segment: number;
  message: CalibrationMessage;
}

export interface LogReadFailure {
  logUrl: string;
  segment: number;
  message: string;
}

export interface SensitiveField<T> {
  value: T;
  redacted: string;
}

export interface CarFirmwareSummary {
  ecu: number;
  ecuName: string;
  fwVersionPython: string;
  pythonSnippet: string;
  fwVersionText: string;
  address: number;
  subAddress: number;
  responseAddress: number;
  request: string[];
  brand: string;
  bus: number;
}

export interface CarParamsSummary {
  logUrl: string;
  segment: number;
  logMonoTime: bigint;
  brand: string;
  carFingerprint: string;
  fuzzyFingerprint: boolean;
  notCar: boolean;
  carVin: SensitiveField<string> | null;
  dashcamOnly: boolean;
  passive: boolean;
  openpilotLongitudinalControl: boolean;
  fingerprintSource: number;
  fingerprintSourceName: string;
  carFw: CarFirmwareSummary[];
}

export interface OnroadEventSummary {
  logUrl: string;
  segment: number;
  logMonoTime: bigint;
  name: number;
  nameText: string;
}

export interface CanEvidenceSummary {
  src: number;
  address: number;
  dataLength: number;
  count: number;
  firstSegment: number;
  lastSegment: number;
}

export interface Recommendation {
  kind: "stock-openpilot" | "sunnypilot" | "fork-context";
  title: string;
  body: string;
  links: Array<{ label: string; url: string }>;
}

export interface FingerprintScanResult {
  routeName: string;
  routeInfo: RouteInfo | null;
  initData: InitDataMessage | null;
  logSource: "qlogs" | "rlogs";
  carParams: CarParamsSummary | null;
  onroadEvents: OnroadEventSummary[];
  canEvidence: CanEvidenceSummary[];
  recommendations: Recommendation[];
  readFailures: LogReadFailure[];
  scannedSegments: number;
  totalSegments: number;
  resultType: "recognized" | "unrecognized" | "incomplete";
}

interface RouteLogContext {
  routeName: string;
  routeInfo: RouteInfo | null;
  logUrls: string[];
  qcameraUrls: string[];
  source: "qlogs" | "rlogs";
}

interface LogSegmentScan {
  calibrationMessages: CalibrationMessage[];
  deviceType: DeviceType | null;
}

interface FingerprintSegmentScan {
  messages: FingerprintLogMessages;
}

export async function scanRouteForFirstValidCalibration(
  input: string,
  onProgress: (progress: ScanProgress) => void,
): Promise<CalibrationScanResult> {
  const context = await loadRouteLogContext(input, onProgress);

  for (let index = 0; index < context.logUrls.length; index += 1) {
    const logUrl = context.logUrls[index];
    const segment = segmentFromUrl(logUrl);
    const { calibrationMessages, deviceType } = await downloadLogSegmentScan(logUrl, segment, index, context.logUrls.length, context.source, onProgress);
    context.routeInfo = routeInfoWithDeviceType(context.routeInfo, context.routeName, deviceType);
    const message = calibrationMessages.find((calibration) => calibration.status === 1 && calibration.rpyCalib.length === 3);
    if (message) {
      onProgress({ phase: "done", message: `Found valid calibration in segment ${segment}` });
      return {
        routeName: context.routeName,
        routeInfo: context.routeInfo,
        logUrl,
        logSource: context.source,
        segment,
        message,
        previousValid: null,
        qcameraPreview: previewForSegment(context.qcameraUrls, 1, "early-route"),
        readFailures: [],
        scannedSegments: index + 1,
        totalSegments: context.logUrls.length,
        scanMode: "quick",
        resultType: "valid",
        reason: "first-valid",
      };
    }
  }

  throw new Error(`Scanned ${context.logUrls.length} uploaded ${logFileKind(context.source)} segment(s), but found no valid liveCalibration messages.`);
}

export async function scanRouteForInvalidCalibration(
  input: string,
  onProgress: (progress: ScanProgress) => void,
): Promise<CalibrationScanResult> {
  const context = await loadRouteLogContext(input, onProgress);
  let firstValid: CalibrationScanMessage | null = null;
  let lastValid: CalibrationScanMessage | null = null;
  let decodedSegments = 0;
  const readFailures: LogReadFailure[] = [];

  for (let index = 0; index < context.logUrls.length; index += 1) {
    const logUrl = context.logUrls[index];
    const segment = segmentFromUrl(logUrl);
    let calibrationMessages: CalibrationMessage[];
    try {
      const segmentScan = await downloadLogSegmentScan(logUrl, segment, index, context.logUrls.length, context.source, onProgress);
      calibrationMessages = segmentScan.calibrationMessages;
      context.routeInfo = routeInfoWithDeviceType(context.routeInfo, context.routeName, segmentScan.deviceType);
      decodedSegments += 1;
    } catch (error) {
      const failure = { logUrl, segment, message: readableLogError(error) };
      readFailures.push(failure);
      onProgress({
        phase: "decode",
        message: `Could not read ${logFileKind(context.source)} segment ${segment}: ${failure.message}`,
        current: index + 1,
        total: context.logUrls.length,
      });
      continue;
    }
    const message = calibrationMessages.find((calibration) => isInvalidCalibration(calibration, context.routeInfo));
    if (message) {
      const reason = message.status === 2 ? "status-invalid" : "outside-current-limits";
      const sameSegmentPreviousValid = calibrationMessages
        .filter((calibration) => calibration.status === 1 && calibration.logMonoTime < message.logMonoTime)
        .at(-1);
      onProgress({ phase: "done", message: `Found invalid calibration in segment ${segment}` });
      return {
        routeName: context.routeName,
        routeInfo: context.routeInfo,
        logUrl,
        logSource: context.source,
        segment,
        message,
        previousValid: sameSegmentPreviousValid ? { logUrl, segment, message: sameSegmentPreviousValid } : lastValid,
        qcameraPreview: previewForSegment(context.qcameraUrls, segment, "invalid-segment"),
        readFailures,
        scannedSegments: index + 1,
        totalSegments: context.logUrls.length,
        scanMode: "full",
        resultType: "invalid",
        reason,
      };
    }
    const validMessages = calibrationMessages.filter((calibration) => calibration.status === 1);
    if (validMessages.length > 0) {
      const validScans = validMessages.map((validMessage) => ({ logUrl, segment, message: validMessage }));
      firstValid ??= validScans[0];
      lastValid = validScans.at(-1) ?? lastValid;
    }
  }

  if (firstValid) {
    if (readFailures.length > 0) {
      onProgress({
        phase: "done",
        message: `No invalid calibration found in ${decodedSegments} decoded ${logFileKind(context.source)} segment(s), but ${readFailures.length} segment(s) could not be read.`,
      });
    } else {
      onProgress({ phase: "done", message: `No invalid calibration found in ${context.logUrls.length} ${logFileKind(context.source)} segment(s).` });
    }
    return {
      routeName: context.routeName,
      routeInfo: context.routeInfo,
      logUrl: firstValid.logUrl,
      logSource: context.source,
      segment: firstValid.segment,
      message: firstValid.message,
      previousValid: null,
      qcameraPreview:
        readFailures.length > 0
          ? previewForSegment(context.qcameraUrls, readFailures[0].segment, "unreadable-segment")
          : previewForSegment(context.qcameraUrls, 1, "early-route"),
      readFailures,
      scannedSegments: decodedSegments,
      totalSegments: context.logUrls.length,
      scanMode: "full",
      resultType: readFailures.length > 0 ? "incomplete" : "valid",
      reason: readFailures.length > 0 ? "scan-incomplete" : "no-invalid-found",
    };
  }

  if (readFailures.length > 0) {
    throw new Error(
      `Decoded ${decodedSegments} uploaded ${logFileKind(context.source)} segment(s) and skipped ${readFailures.length} unreadable segment(s), but found no invalid or valid liveCalibration messages.`,
    );
  }
  throw new Error(`Scanned ${decodedSegments} uploaded ${logFileKind(context.source)} segment(s), but found no invalid or valid liveCalibration messages.`);
}

export async function scanRouteForFingerprintDebug(
  input: string,
  onProgress: (progress: ScanProgress) => void,
): Promise<FingerprintScanResult> {
  const context = await loadRouteLogContext(input, onProgress);
  const readFailures: LogReadFailure[] = [];
  const carParams: CarParamsSummary[] = [];
  const onroadEvents: OnroadEventSummary[] = [];
  const canEvidence = new Map<string, CanEvidenceSummary>();
  let initData: InitDataMessage | null = null;
  let decodedSegments = 0;
  const sampledLogUrls = context.logUrls.slice(0, 1);

  for (let index = 0; index < sampledLogUrls.length; index += 1) {
    const logUrl = sampledLogUrls[index];
    const segment = segmentFromUrl(logUrl);
    try {
      const segmentScan = await downloadFingerprintSegmentScan(logUrl, segment, index, sampledLogUrls.length, context.source, onProgress);
      decodedSegments += 1;
      initData ??= segmentScan.messages.initData;
      context.routeInfo = routeInfoWithDeviceType(context.routeInfo, context.routeName, segmentScan.messages.deviceType);
      carParams.push(...segmentScan.messages.carParams.map((message) => summarizeCarParams(message, logUrl, segment)));
      onroadEvents.push(...segmentScan.messages.onroadEvents.map((message) => summarizeOnroadEvent(message, logUrl, segment)));
      mergeCanEvidence(canEvidence, segmentScan.messages, segment);
    } catch (error) {
      const failure = { logUrl, segment, message: readableLogError(error) };
      readFailures.push(failure);
      onProgress({
        phase: "decode",
        message: `Could not read ${logFileKind(context.source)} segment ${segment}: ${failure.message}`,
        current: index + 1,
        total: context.logUrls.length,
      });
    }
  }

  const selectedCarParams = carParams.at(-1) ?? null;
  const recognized = Boolean(selectedCarParams?.carFingerprint);
  const resultType = readFailures.length > 0 ? "incomplete" : recognized ? "recognized" : "unrecognized";
  onProgress({
    phase: "done",
    message: recognized
      ? `Found ${selectedCarParams?.carFingerprint} after scanning ${decodedSegments} ${logFileKind(context.source)} segment(s).`
      : `Built fingerprint evidence from ${decodedSegments} sampled ${logFileKind(context.source)} segment(s).`,
  });

  return {
    routeName: context.routeName,
    routeInfo: context.routeInfo,
    initData,
    logSource: context.source,
    carParams: selectedCarParams,
    onroadEvents: dedupeEvents(onroadEvents),
    canEvidence: [...canEvidence.values()].sort((a, b) => a.src - b.src || a.address - b.address || a.dataLength - b.dataLength),
    recommendations: buildRecommendations(selectedCarParams, onroadEvents, initData, readFailures),
    readFailures,
    scannedSegments: decodedSegments,
    totalSegments: context.logUrls.length,
    resultType,
  };
}

async function loadRouteLogContext(
  input: string,
  onProgress: (progress: ScanProgress) => void,
): Promise<RouteLogContext> {
  const parsed = parseRouteInput(input);
  onProgress({ phase: "metadata", message: `Reading file list for ${parsed.routeName}` });

  const [routeInfo, files] = await Promise.all([fetchRouteInfo(parsed.routeName), fetchRouteFiles(parsed.routeName)]);
  const logUrls = orderedLogUrls(files);
  const qcameraUrls = orderedQcameraUrls(files);
  if (logUrls.length === 0) {
    throw new Error("No qlogs or rlogs are uploaded for this route.");
  }
  const source = logSourceLabel(files);
  if (source === "none") {
    throw new Error("No qlogs or rlogs are uploaded for this route.");
  }
  if (source === "rlogs") {
    onProgress({ phase: "metadata", message: "No qlogs found; falling back to rlogs." });
  }

  return { routeName: parsed.routeName, routeInfo, logUrls, qcameraUrls, source };
}

async function downloadLogSegmentScan(
  logUrl: string,
  segment: number,
  index: number,
  total: number,
  source: "qlogs" | "rlogs",
  onProgress: (progress: ScanProgress) => void,
): Promise<LogSegmentScan> {
  onProgress({
    phase: "download",
    message: `Downloading ${logFileKind(source)} segment ${segment} (${index + 1}/${total})`,
    current: index + 1,
    total,
  });

  const compressed = new Uint8Array(await (await fetchLog(logUrl)).arrayBuffer());
  onProgress({
    phase: "decode",
    message: `Decoding segment ${segment}`,
    current: index + 1,
    total,
  });

  const decompressed = decompressLog(compressed, logUrl);
  return {
    calibrationMessages: findCalibrationMessages(decompressed, (calibration) => calibration.rpyCalib.length === 3),
    deviceType: findDeviceType(decompressed),
  };
}

async function downloadFingerprintSegmentScan(
  logUrl: string,
  segment: number,
  index: number,
  total: number,
  source: "qlogs" | "rlogs",
  onProgress: (progress: ScanProgress) => void,
): Promise<FingerprintSegmentScan> {
  onProgress({
    phase: "download",
    message: `Downloading ${logFileKind(source)} segment ${segment} (${index + 1}/${total})`,
    current: index + 1,
    total,
  });

  const compressed = new Uint8Array(await (await fetchLog(logUrl)).arrayBuffer());
  onProgress({
    phase: "decode",
    message: `Decoding fingerprint evidence in segment ${segment}`,
    current: index + 1,
    total,
  });

  const decompressed = decompressLog(compressed, logUrl);
  return { messages: findFingerprintLogMessages(decompressed) };
}

async function fetchLog(logUrl: string): Promise<Response> {
  const response = await fetch(logUrl);
  if (!response.ok) {
    throw new Error(`Could not download ${logUrl.split("?", 1)[0]} (${response.status}).`);
  }
  return response;
}

function logFileKind(source: "qlogs" | "rlogs"): "qlog" | "rlog" {
  return source === "qlogs" ? "qlog" : "rlog";
}

function readableLogError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("unexpected eof")) {
    return "unexpected EOF while decompressing; this log segment looks truncated";
  }
  return message;
}

function routeInfoWithDeviceType(routeInfo: RouteInfo | null, routeName: string, deviceType: DeviceType | null): RouteInfo | null {
  if (!deviceType || deviceType === "unknown" || routeInfo?.deviceType === deviceType) return routeInfo;
  return {
    fullname: routeInfo?.fullname ?? routeName,
    ...routeInfo,
    deviceType,
    devicetype: deviceType === "mici" ? 7 : routeInfo?.devicetype,
  };
}

function previewForSegment(
  qcameraUrls: string[],
  preferredSegment: number,
  reason: QcameraPreviewSource["reason"],
): QcameraPreviewSource | null {
  if (qcameraUrls.length === 0) return null;
  const exact = qcameraUrls.find((url) => segmentFromUrl(url) === preferredSegment);
  if (exact) return { logUrl: exact, segment: preferredSegment, reason };

  const nearest =
    qcameraUrls
      .map((url) => ({ url, segment: segmentFromUrl(url) }))
      .filter(({ segment }) => Number.isFinite(segment))
      .sort((a, b) => Math.abs(a.segment - preferredSegment) - Math.abs(b.segment - preferredSegment))[0] ?? null;
  return nearest ? { logUrl: nearest.url, segment: nearest.segment, reason } : null;
}

function summarizeCarParams(message: CarParamsMessage, logUrl: string, segment: number): CarParamsSummary {
  return {
    logUrl,
    segment,
    logMonoTime: message.logMonoTime,
    brand: message.brand,
    carFingerprint: message.carFingerprint,
    fuzzyFingerprint: message.fuzzyFingerprint,
    notCar: message.notCar,
    carVin: message.carVin ? { value: message.carVin, redacted: redactVin(message.carVin) } : null,
    dashcamOnly: message.dashcamOnly,
    passive: message.passive,
    openpilotLongitudinalControl: message.openpilotLongitudinalControl,
    fingerprintSource: message.fingerprintSource,
    fingerprintSourceName: message.fingerprintSourceName,
    carFw: message.carFw.map((fw) => ({
      ecu: fw.ecu,
      ecuName: fw.ecuName,
      fwVersionPython: fw.fwVersionPython,
      pythonSnippet: pythonFirmwareSnippet(fw.ecuName, fw.address, fw.subAddress, fw.fwVersionPython),
      fwVersionText: fw.fwVersionText,
      address: fw.address,
      subAddress: fw.subAddress,
      responseAddress: fw.responseAddress,
      request: fw.request,
      brand: fw.brand,
      bus: fw.bus,
    })),
  };
}

function summarizeOnroadEvent(message: OnroadEventMessage, logUrl: string, segment: number): OnroadEventSummary {
  return {
    logUrl,
    segment,
    logMonoTime: message.logMonoTime,
    name: message.name,
    nameText: message.nameText,
  };
}

function mergeCanEvidence(target: Map<string, CanEvidenceSummary>, messages: FingerprintLogMessages, segment: number): void {
  for (const can of messages.canMessages) {
    const key = `${can.src}:${can.address}:${can.dataLength}`;
    const existing = target.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastSegment = Math.max(existing.lastSegment, segment);
      existing.firstSegment = Math.min(existing.firstSegment, segment);
    } else {
      target.set(key, {
        src: can.src,
        address: can.address,
        dataLength: can.dataLength,
        count: 1,
        firstSegment: segment,
        lastSegment: segment,
      });
    }
  }
}

function dedupeEvents(events: OnroadEventSummary[]): OnroadEventSummary[] {
  const seen = new Set<string>();
  const deduped: OnroadEventSummary[] = [];
  for (const event of events) {
    const key = `${event.segment}:${event.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(event);
  }
  return deduped;
}

function buildRecommendations(
  carParams: CarParamsSummary | null,
  events: OnroadEventSummary[],
  initData: InitDataMessage | null,
  readFailures: LogReadFailure[],
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const recognized = Boolean(carParams?.carFingerprint);
  const unrecognizedEvent = events.some((event) => event.nameText === "carUnrecognized" || event.nameText === "startupNoCar" || event.nameText === "dashcamMode");
  const sunnyish = isSunnyPilotMetadata(initData);

  recommendations.push({
    kind: "stock-openpilot",
    title: recognized ? "Stock openpilot evidence" : "Stock openpilot next step",
    body: recognized
      ? `Route logged ${carParams?.carFingerprint}; use the firmware and CAN evidence below if you are comparing against upstream fingerprints.`
      : "If this was stock openpilot, try current nightly-dev first and share this report with the brand channel or an upstream fingerprinting issue.",
    links: [
      { label: "openpilot fingerprinting guide", url: OPENPILOT_FINGERPRINTING_URL },
      { label: "nightly-dev installer", url: OPENPILOT_NIGHTLY_DEV_INSTALLER_URL },
    ],
  });

  recommendations.push({
    kind: "sunnypilot",
    title: sunnyish || unrecognizedEvent ? "SunnyPilot car selector" : "SunnyPilot option",
    body: "On SunnyPilot, use SunnyLink or the vehicle settings car selector to manually select the vehicle when automatic recognition is not enough. comma four users may need SunnyLink for selection.",
    links: [
      { label: "SunnyLink", url: SUNNYLINK_URL },
      { label: "SunnyPilot vehicle settings", url: SUNNYPILOT_VEHICLE_SETTINGS_URL },
      { label: "SunnyPilot", url: SUNNYPILOT_URL },
      { label: "release-mici installer", url: SUNNYPILOT_RELEASE_MICI_INSTALLER_URL },
    ],
  });

  if (!recognized) {
    recommendations.push({
      kind: "fork-context",
      title: "Fork context",
      body: "hardcoded-fp can be useful context when someone is deliberately testing fixed fingerprints, but this report does not choose or recommend a hardcoded branch. Use the evidence here with human review.",
      links: [
        { label: "hardcoded-fp branch index", url: HARDCODED_FP_BRANCH_INDEX_URL },
        { label: "hardcoded-fp repo", url: HARDCODED_FP_REPO_URL },
      ],
    });
  }

  if (readFailures.length > 0) {
    recommendations.unshift({
      kind: "stock-openpilot",
      title: "Scan incomplete",
      body: `${readFailures.length} segment(s) could not be decoded. Re-run with uploaded qlogs/rlogs available before treating missing evidence as meaningful.`,
      links: [],
    });
  }

  return recommendations;
}

function redactVin(vin: string): string {
  if (vin.length <= 6) return "redacted";
  return `${vin.slice(0, 3)}${"*".repeat(Math.max(4, vin.length - 6))}${vin.slice(-3)}`;
}

function isSunnyPilotMetadata(initData: InitDataMessage | null): boolean {
  const haystack = [initData?.gitRemote, initData?.gitBranch, initData?.version, initData?.gitSrcCommit].join(" ").toLowerCase();
  return haystack.includes("sunnypilot") || haystack.includes("sunny");
}

function pythonFirmwareSnippet(ecuName: string, address: number, subAddress: number, fwVersionPython: string): string {
  const ecu = ecuName.startsWith("ecu ") ? `Ecu.unknown  # raw ecu ${ecuName.slice(4)}` : `Ecu.${ecuName}`;
  const subAddressText = subAddress === 0 ? "None" : `0x${subAddress.toString(16)}`;
  return `(${ecu}, 0x${address.toString(16)}, ${subAddressText}): [\n  ${fwVersionPython},\n],`;
}
