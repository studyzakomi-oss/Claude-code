import Constants from 'expo-constants';
import * as Location from 'expo-location';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  cancelReminder,
  ensureBackgroundLocationPermission,
  ensureNotificationPermission,
  markPastTimeReminders,
  scheduleTimeReminder,
  setupNotifications,
  syncGeofences,
} from './src/engine';
import { parseReminder, placeKey, type ParseResult } from './src/parser';
import { loadPlaces, newId, savePlaces, saveReminders, type Place, type Reminder } from './src/storage';

const DEFAULT_RADIUS = 150;

const C = {
  bg: '#F6F4EF',
  card: '#FFFFFF',
  ink: '#1F2328',
  muted: '#6B7078',
  line: '#E4E1DA',
  accent: '#2F6F5E',
  accentSoft: '#E3EFEA',
  warn: '#A4492E',
};

function pad(n: number) {
  return String(n).padStart(2, '0');
}

export function formatWhen(at: Date, now = new Date()): string {
  const h = at.getHours();
  const time = `${h % 12 === 0 ? 12 : h % 12}:${pad(at.getMinutes())} ${h < 12 ? 'ص' : 'م'}`;
  const day = new Date(at).setHours(0, 0, 0, 0);
  const today = new Date(now).setHours(0, 0, 0, 0);
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === 0) return `اليوم ${time}`;
  if (diff === 1) return `غداً ${time}`;
  if (diff === 2) return `بعد غد ${time}`;
  return `${at.getDate()}/${at.getMonth() + 1} ${time}`;
}

function describe(r: ParseResult, places: Place[]): { label: string; ok: boolean } {
  if (!r.trigger) return { label: 'اكتب وقتاً (الساعة 5، بعد 10 دقائق، بكرة…) أو مكاناً (لما أخرج من الجامعة…)', ok: false };
  if (!r.text) return { label: 'بماذا أذكّرك؟', ok: false };
  if (r.trigger.kind === 'time') {
    if (r.trigger.at.getTime() <= Date.now()) return { label: 'هذا الوقت مضى', ok: false };
    return { label: `⏰ ${formatWhen(r.trigger.at)}`, ok: true };
  }
  const key = placeKey(r.trigger.place);
  const known = places.some((p) => placeKey(p.name) === key);
  const verb = r.trigger.event === 'exit' ? 'عند الخروج من' : 'عند الوصول إلى';
  return { label: `📍 ${verb} ${r.trigger.place}${known ? '' : ' (مكان جديد)'}`, ok: true };
}

async function currentPosition() {
  const { granted } = await Location.requestForegroundPermissionsAsync();
  if (!granted) throw new Error('لم يُسمح بالوصول إلى الموقع');
  return Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
}

export default function App() {
  const [input, setInput] = useState('');
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);
  const [newPlace, setNewPlace] = useState('');

  const refresh = useCallback(async () => {
    const [r, p] = await Promise.all([markPastTimeReminders(), loadPlaces()]);
    setReminders(r);
    setPlaces(p);
  }, []);

  useEffect(() => {
    setupNotifications();
    refresh();
    const sub = AppState.addEventListener('change', (s) => s === 'active' && refresh());
    return () => sub.remove();
  }, [refresh]);

  const parsed = useMemo(() => parseReminder(input), [input]);
  const preview = describe(parsed, places);

  async function persist(nextReminders: Reminder[], nextPlaces = places) {
    await Promise.all([saveReminders(nextReminders), savePlaces(nextPlaces)]);
    setReminders(nextReminders);
    setPlaces(nextPlaces);
    await syncGeofences();
  }

  async function savePlaceHere(name: string, list = places): Promise<Place[]> {
    const pos = await currentPosition();
    const place: Place = {
      id: newId(),
      name: name.trim(),
      latitude: pos.coords.latitude,
      longitude: pos.coords.longitude,
      radius: DEFAULT_RADIUS,
    };
    const next = [...list.filter((p) => placeKey(p.name) !== placeKey(name)), place];
    await savePlaces(next);
    setPlaces(next);
    return next;
  }

  async function addLocationReminder(text: string, event: 'exit' | 'enter', place: Place, placeList: Place[]) {
    if (!(await ensureBackgroundLocationPermission())) {
      Alert.alert(
        'نحتاج إذن الموقع "طوال الوقت"',
        'حتى يعمل التذكير عند الخروج أو الوصول والتطبيق مغلق، اختر "السماح طوال الوقت" من إعدادات الموقع.',
      );
      return;
    }
    const r: Reminder = { id: newId(), text, createdAt: Date.now(), done: false, trigger: { kind: 'location', event, placeId: place.id } };
    await persist([r, ...reminders], placeList);
    setInput('');
  }

  async function add() {
    if (!preview.ok || !parsed.trigger) return;
    setBusy(true);
    try {
      if (!(await ensureNotificationPermission())) {
        Alert.alert('الإشعارات متوقفة', 'فعّل الإشعارات للتطبيق من الإعدادات حتى تصلك التذكيرات.');
        return;
      }
      const { trigger, text } = parsed;
      if (trigger.kind === 'time') {
        const notificationId = await scheduleTimeReminder(text, trigger.at);
        const r: Reminder = { id: newId(), text, createdAt: Date.now(), done: false, trigger: { kind: 'time', at: trigger.at.getTime(), notificationId } };
        await persist([r, ...reminders]);
        setInput('');
        return;
      }

      const existing = places.find((p) => placeKey(p.name) === placeKey(trigger.place));
      if (existing) {
        await addLocationReminder(text, trigger.event, existing, places);
        return;
      }
      Alert.alert(
        `أين "${trigger.place}"؟`,
        'هذا المكان غير محفوظ. إذا كنت فيه الآن احفظ موقعك الحالي باسمه.',
        [
          { text: 'إلغاء', style: 'cancel' },
          {
            text: 'أنا فيه الآن — احفظه',
            onPress: async () => {
              setBusy(true);
              try {
                const next = await savePlaceHere(trigger.place);
                const place = next[next.length - 1];
                await addLocationReminder(text, trigger.event, place, next);
              } catch (e) {
                Alert.alert('تعذّر تحديد الموقع', String((e as Error).message ?? e));
              } finally {
                setBusy(false);
              }
            },
          },
        ],
      );
    } catch (e) {
      Alert.alert('حدث خطأ', String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Reminder) {
    await cancelReminder(r);
    await persist(reminders.filter((x) => x.id !== r.id));
  }

  async function removePlace(p: Place) {
    const used = reminders.some((r) => !r.done && r.trigger.kind === 'location' && r.trigger.placeId === p.id);
    const doRemove = async () => {
      await persist(
        reminders.filter((r) => !(r.trigger.kind === 'location' && r.trigger.placeId === p.id)),
        places.filter((x) => x.id !== p.id),
      );
    };
    if (!used) return doRemove();
    Alert.alert('حذف المكان', `توجد تذكيرات مرتبطة بـ "${p.name}" وستُحذف أيضاً.`, [
      { text: 'إلغاء', style: 'cancel' },
      { text: 'حذف', style: 'destructive', onPress: doRemove },
    ]);
  }

  async function addPlaceManually() {
    if (!newPlace.trim()) return;
    setBusy(true);
    try {
      await savePlaceHere(newPlace);
      setNewPlace('');
      await syncGeofences();
    } catch (e) {
      Alert.alert('تعذّر تحديد الموقع', String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  }

  const placeName = (id: string) => places.find((p) => p.id === id)?.name ?? '؟';
  const active = reminders.filter((r) => !r.done);
  const done = reminders.filter((r) => r.done).slice(0, 10);

  function when(r: Reminder) {
    if (r.trigger.kind === 'time') return `⏰ ${formatWhen(new Date(r.trigger.at))}`;
    return `📍 ${r.trigger.event === 'exit' ? 'عند الخروج من' : 'عند الوصول إلى'} ${placeName(r.trigger.placeId)}`;
  }

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>ذكّرني</Text>
        <Text style={styles.subtitle}>قل ما تريد بكلماتك: بوقت، أو عند الخروج من مكان أو الوصول إليه.</Text>

        <View style={styles.card}>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="لما أخرج من الجامعة ذكرني أشتري خبز"
            placeholderTextColor={C.muted}
            multiline
            textAlign="right"
          />
          {input.trim().length > 0 && (
            <View style={styles.preview}>
              {parsed.text ? <Text style={styles.previewText}>«{parsed.text}»</Text> : null}
              <Text style={[styles.previewWhen, !preview.ok && { color: C.warn }]}>{preview.label}</Text>
            </View>
          )}
          <Pressable
            style={[styles.button, (!preview.ok || busy) && styles.buttonDisabled]}
            disabled={!preview.ok || busy}
            onPress={add}
          >
            {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>أضف التذكير</Text>}
          </Pressable>
        </View>

        <Text style={styles.section}>القادمة</Text>
        {active.length === 0 && <Text style={styles.empty}>لا توجد تذكيرات بعد.</Text>}
        {active.map((r) => (
          <View key={r.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowText}>{r.text}</Text>
              <Text style={styles.rowWhen}>{when(r)}</Text>
            </View>
            <Pressable onPress={() => remove(r)} hitSlop={12}>
              <Text style={styles.delete}>✕</Text>
            </Pressable>
          </View>
        ))}

        <Text style={styles.section}>أماكني</Text>
        {places.map((p) => (
          <View key={p.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.rowText}>{p.name}</Text>
              <Text style={styles.rowWhen}>نطاق {p.radius} م</Text>
            </View>
            <Pressable onPress={() => removePlace(p)} hitSlop={12}>
              <Text style={styles.delete}>✕</Text>
            </Pressable>
          </View>
        ))}
        <View style={styles.placeAdd}>
          <TextInput
            style={[styles.input, styles.placeInput]}
            value={newPlace}
            onChangeText={setNewPlace}
            placeholder="اسم المكان (البيت، الجامعة…)"
            placeholderTextColor={C.muted}
            textAlign="right"
          />
          <Pressable style={[styles.smallButton, !newPlace.trim() && styles.buttonDisabled]} onPress={addPlaceManually} disabled={!newPlace.trim() || busy}>
            <Text style={styles.buttonText}>احفظ موقعي هنا</Text>
          </Pressable>
        </View>

        {done.length > 0 && (
          <>
            <Text style={styles.section}>المنتهية</Text>
            {done.map((r) => (
              <View key={r.id} style={[styles.row, styles.rowDone]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.rowText, { color: C.muted }]}>{r.text}</Text>
                  <Text style={styles.rowWhen}>{when(r)}</Text>
                </View>
                <Pressable onPress={() => remove(r)} hitSlop={12}>
                  <Text style={styles.delete}>✕</Text>
                </Pressable>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const rtl = { textAlign: 'right' as const, writingDirection: 'rtl' as const };

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg, paddingTop: Constants.statusBarHeight },
  content: { padding: 20, paddingBottom: 60 },
  title: { ...rtl, fontSize: 32, fontWeight: '700', color: C.ink },
  subtitle: { ...rtl, fontSize: 15, color: C.muted, marginTop: 4, marginBottom: 18, lineHeight: 22 },
  card: { backgroundColor: C.card, borderRadius: 16, padding: 14, borderWidth: 1, borderColor: C.line },
  input: { ...rtl, fontSize: 17, color: C.ink, minHeight: 56, paddingVertical: 8 },
  preview: { backgroundColor: C.accentSoft, borderRadius: 10, padding: 10, marginTop: 8, gap: 4 },
  previewText: { ...rtl, fontSize: 16, color: C.ink, fontWeight: '600' },
  previewWhen: { ...rtl, fontSize: 14, color: C.accent },
  button: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 12 },
  buttonDisabled: { opacity: 0.4 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  section: { ...rtl, fontSize: 18, fontWeight: '700', color: C.ink, marginTop: 28, marginBottom: 10 },
  empty: { ...rtl, color: C.muted, fontSize: 15 },
  row: {
    flexDirection: 'row-reverse',
    alignItems: 'center',
    gap: 12,
    backgroundColor: C.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: C.line,
  },
  rowDone: { backgroundColor: 'transparent' },
  rowText: { ...rtl, fontSize: 16, color: C.ink },
  rowWhen: { ...rtl, fontSize: 13, color: C.muted, marginTop: 3 },
  delete: { fontSize: 16, color: C.muted, paddingHorizontal: 4 },
  placeAdd: { flexDirection: 'row-reverse', alignItems: 'center', gap: 8, marginTop: 4 },
  placeInput: {
    flex: 1,
    minHeight: 44,
    backgroundColor: C.card,
    borderRadius: 12,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: C.line,
  },
  smallButton: { backgroundColor: C.accent, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 14 },
});
