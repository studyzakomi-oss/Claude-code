import { describe, expect, test } from '@jest/globals';
import { parseReminder, placeKey } from './parser';

// Saturday 2026-10-17 14:00 local time
const NOW = new Date(2026, 9, 17, 14, 0, 0);

function at(day: number, h: number, m = 0) {
  return new Date(2026, 9, day, h, m, 0).getTime();
}

function timeOf(input: string) {
  const r = parseReminder(input, NOW);
  if (r.trigger?.kind !== 'time') throw new Error(`no time in: ${input}`);
  return { text: r.text, at: r.trigger.at.getTime() };
}

describe('location reminders', () => {
  test.each([
    ['لما اخرج من الجامعه ذكرني بكذه', 'exit', 'الجامعه', 'كذه'],
    ['لما أخرج من الجامعة ذكرني أشتري خبز', 'exit', 'الجامعة', 'أشتري خبز'],
    ['ذكرني اتصل بأحمد لما اطلع من الجامعة', 'exit', 'الجامعة', 'اتصل بأحمد'],
    ['عند خروجي من المكتب ذكرني بالدواء', 'exit', 'المكتب', 'الدواء'],
    ['لما أوصل البيت ذكرني أشحن الجوال', 'enter', 'البيت', 'أشحن الجوال'],
    ['لما اوصل للبيت ذكرني اغسل الملابس', 'enter', 'البيت', 'اغسل الملابس'],
    ['عند وصولي إلى المكتبة ذكرني بإرجاع الكتاب', 'enter', 'المكتبة', 'إرجاع الكتاب'],
    ['Remind me to buy milk when I leave the university', 'exit', 'university', 'buy milk'],
    ['when I get home remind me to call mom', 'enter', 'home', 'call mom'],
    ['when I arrive at the gym, remind me to stretch', 'enter', 'gym', 'stretch'],
  ])('%s', (input: string, event: string, place: string, text: string) => {
    const r = parseReminder(input, NOW);
    expect(r.trigger).toEqual({ kind: 'location', event, place });
    expect(r.text).toBe(text);
  });
});

describe('time reminders', () => {
  test('relative arabic minutes', () => {
    expect(timeOf('ذكرني بالفرن بعد 10 دقائق')).toEqual({ text: 'الفرن', at: at(17, 14, 10) });
  });
  test('relative arabic dual hours with arabic digits', () => {
    expect(timeOf('بعد ساعتين ذكرني اذاكر').at).toBe(at(17, 16));
    expect(timeOf('ذكرني بعد ٣ ساعات اصلي').at).toBe(at(17, 17));
  });
  test('half an hour', () => {
    expect(timeOf('ذكرني بعد نص ساعة اطفي الغاز').at).toBe(at(17, 14, 30));
    expect(timeOf('remind me in half an hour to stretch').at).toBe(at(17, 14, 30));
  });
  test('relative english', () => {
    expect(timeOf('remind me to call Sara in 2 hours')).toEqual({ text: 'call Sara', at: at(17, 16) });
  });
  test('bare hour picks the next occurrence', () => {
    expect(timeOf('ذكرني اتصل بأمي الساعة 5').at).toBe(at(17, 17));
    expect(timeOf('ذكرني الساعة 1 اتغدى').at).toBe(at(18, 1));
  });
  test('explicit periods', () => {
    expect(timeOf('ذكرني الساعة 8 الصبح بالمحاضرة')).toEqual({ text: 'المحاضرة', at: at(18, 8) });
    expect(timeOf('ذكرني الساعة 9:30 مساء انام').at).toBe(at(17, 21, 30));
    expect(timeOf('الساعة 7 ونص المساء ذكرني بالعشاء').at).toBe(at(17, 19, 30));
    expect(timeOf('remind me at 6pm to go running')).toEqual({ text: 'go running', at: at(17, 18) });
  });
  test('tomorrow', () => {
    expect(timeOf('بكرة الساعة 10 ذكرني بالامتحان')).toEqual({ text: 'الامتحان', at: at(18, 10) });
    expect(timeOf('ذكرني بكره الساعه 5 اروح السوق').at).toBe(at(18, 17));
    expect(timeOf('remind me tomorrow to pay rent').at).toBe(at(18, 9));
    expect(timeOf('remind me tomorrow at 7:15 am to wake up').at).toBe(at(18, 7, 15));
  });
  test('tonight', () => {
    expect(timeOf('ذكرني الليلة الساعة 11 اراجع الدرس').at).toBe(at(17, 23));
  });
});

test('no trigger', () => {
  expect(parseReminder('ذكرني اشتري خبز', NOW)).toEqual({ text: 'اشتري خبز', trigger: null });
});

test('placeKey ignores article and spelling', () => {
  expect(placeKey('الجامعة')).toBe(placeKey('جامعه'));
  expect(placeKey('The Gym')).toBe(placeKey('gym'));
});
