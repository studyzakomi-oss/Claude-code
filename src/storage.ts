import AsyncStorage from '@react-native-async-storage/async-storage';

export type Place = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  radius: number;
};

export type Trigger =
  | { kind: 'time'; at: number; notificationId?: string }
  | { kind: 'location'; event: 'exit' | 'enter'; placeId: string };

export type Reminder = {
  id: string;
  text: string;
  createdAt: number;
  done: boolean;
  firedAt?: number;
  trigger: Trigger;
};

const REMINDERS_KEY = 'reminders.v1';
const PLACES_KEY = 'places.v1';

async function load<T>(key: string): Promise<T[]> {
  const raw = await AsyncStorage.getItem(key);
  return raw ? (JSON.parse(raw) as T[]) : [];
}

export const loadReminders = () => load<Reminder>(REMINDERS_KEY);
export const loadPlaces = () => load<Place>(PLACES_KEY);

export const saveReminders = (items: Reminder[]) => AsyncStorage.setItem(REMINDERS_KEY, JSON.stringify(items));
export const savePlaces = (items: Place[]) => AsyncStorage.setItem(PLACES_KEY, JSON.stringify(items));

export function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
