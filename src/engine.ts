// Delivers reminders: time reminders become scheduled local notifications,
// location reminders become OS geofences that wake the app in the background.
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { loadPlaces, loadReminders, saveReminders, type Reminder } from './storage';

export const GEOFENCE_TASK = 'reminder-geofence';
const CHANNEL_ID = 'reminders';

// Android reports "enter" right after registering a fence you are already
// inside; ignore that echo so "when I arrive" doesn't fire on the spot.
let lastFenceSync = 0;
const ENTER_GRACE_MS = 20_000;

type GeofenceData = {
  eventType: Location.LocationGeofencingEventType;
  region: Location.LocationRegion;
};

// Must run at module load (imported from index.ts) so the OS can wake the
// task while the app is closed.
TaskManager.defineTask<GeofenceData>(GEOFENCE_TASK, async ({ data, error }) => {
  if (error || !data?.region.identifier) return;
  const event = data.eventType === Location.LocationGeofencingEventType.Exit ? 'exit' : 'enter';
  if (event === 'enter' && Date.now() - lastFenceSync < ENTER_GRACE_MS) return;
  await fireLocationReminders(data.region.identifier, event);
});

async function fireLocationReminders(placeId: string, event: 'exit' | 'enter') {
  const reminders = await loadReminders();
  const due = reminders.filter(
    (r) => !r.done && r.trigger.kind === 'location' && r.trigger.placeId === placeId && r.trigger.event === event,
  );
  if (due.length === 0) return;

  const places = await loadPlaces();
  const place = places.find((p) => p.id === placeId);
  for (const r of due) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: event === 'exit' ? `خرجت من ${place?.name ?? 'المكان'}` : `وصلت إلى ${place?.name ?? 'المكان'}`,
        body: r.text,
        sound: true,
      },
      trigger: null,
    });
    r.done = true;
    r.firedAt = Date.now();
  }
  await saveReminders(reminders);
  await syncGeofences();
}

export async function setupNotifications() {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'التذكيرات',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    });
  }
}

export async function ensureNotificationPermission(): Promise<boolean> {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  return (await Notifications.requestPermissionsAsync()).granted;
}

// Geofences only work with "Allow all the time" location access.
export async function ensureBackgroundLocationPermission(): Promise<boolean> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (!fg.granted) return false;
  const bg = await Location.requestBackgroundPermissionsAsync();
  return bg.granted;
}

export async function scheduleTimeReminder(text: string, at: Date): Promise<string> {
  return Notifications.scheduleNotificationAsync({
    content: { title: 'تذكير', body: text, sound: true },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at, channelId: CHANNEL_ID },
  });
}

export async function cancelReminder(r: Reminder) {
  if (r.trigger.kind === 'time' && r.trigger.notificationId) {
    await Notifications.cancelScheduledNotificationAsync(r.trigger.notificationId).catch(() => {});
  }
}

// Registers exactly the places that still have pending location reminders.
export async function syncGeofences() {
  const [reminders, places] = await Promise.all([loadReminders(), loadPlaces()]);
  const wanted = new Map<string, { exit: boolean; enter: boolean }>();
  for (const r of reminders) {
    if (r.done || r.trigger.kind !== 'location') continue;
    const w = wanted.get(r.trigger.placeId) ?? { exit: false, enter: false };
    w[r.trigger.event] = true;
    wanted.set(r.trigger.placeId, w);
  }

  const regions: Location.LocationRegion[] = places
    .filter((p) => wanted.has(p.id))
    .map((p) => ({
      identifier: p.id,
      latitude: p.latitude,
      longitude: p.longitude,
      radius: p.radius,
      notifyOnExit: wanted.get(p.id)!.exit,
      notifyOnEnter: wanted.get(p.id)!.enter,
    }));

  const running = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK).catch(() => false);
  if (regions.length === 0) {
    if (running) await Location.stopGeofencingAsync(GEOFENCE_TASK);
    return;
  }
  const { granted } = await Location.getBackgroundPermissionsAsync();
  if (!granted) return;
  lastFenceSync = Date.now();
  await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
}

// Time reminders whose moment has passed are moved to the "done" list.
export async function markPastTimeReminders(): Promise<Reminder[]> {
  const reminders = await loadReminders();
  let changed = false;
  for (const r of reminders) {
    if (!r.done && r.trigger.kind === 'time' && r.trigger.at <= Date.now()) {
      r.done = true;
      r.firedAt = r.trigger.at;
      changed = true;
    }
  }
  if (changed) await saveReminders(reminders);
  return reminders;
}
