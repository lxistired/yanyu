class AdapterError extends Error { constructor(code,message){super(message);this.code=code;} }
const invalid = (message)=>new AdapterError('INVALID_REQUEST', message);
function object(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw invalid('Expected a plain configuration object');
    const result = value;
    if (Object.keys(result).some((key)=>!allowed.includes(key))) throw invalid('Unsupported configuration field; credentials, endpoints and executable code are not accepted');
    return result;
}
function choice(value, choices, field) {
    if (typeof value !== 'string' || !choices.includes(value)) throw invalid(`Unsupported ${field}`);
    return value;
}
function integer(value, min, max, field) {
    if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw invalid(`Invalid ${field}`);
    return Number(value);
}
function instant(value) {
    if (typeof value !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/.test(value)) throw invalid('Time must be an ISO instant with an explicit UTC offset');
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() < 1970 || parsed.getUTCFullYear() > 2099) throw invalid('Time must be between 1970 and 2099');
    const [year, month, day] = value.slice(0, 10).split('-').map(Number);
    if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) throw invalid('Invalid calendar date');
    return parsed.toISOString();
}
function timezone(value) {
    if (typeof value !== 'string' || value.length > 100 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(value)) throw invalid('Expected an IANA timezone');
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: value
        }).resolvedOptions().timeZone;
    } catch  {
        throw invalid('Unknown IANA timezone');
    }
}
export function validateScheduleCadence(value) {
    const input = object(value, [
        'kind',
        'at',
        'time',
        'timezone',
        'weekdays'
    ]);
    const zone = timezone(input.timezone);
    if (input.kind === 'once') {
        object(value, [
            'kind',
            'at',
            'timezone'
        ]);
        return {
            kind: 'once',
            at: instant(input.at),
            timezone: zone
        };
    }
    const kind = choice(input.kind, [
        'daily',
        'weekly'
    ], 'schedule cadence');
    object(value, kind === 'daily' ? [
        'kind',
        'time',
        'timezone'
    ] : [
        'kind',
        'time',
        'timezone',
        'weekdays'
    ]);
    if (typeof input.time !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw invalid('Wall time must be HH:mm');
    if (kind === 'daily') return {
        kind,
        time: input.time,
        timezone: zone
    };
    if (!Array.isArray(input.weekdays) || input.weekdays.length < 1 || input.weekdays.length > 7) throw invalid('Weekly schedules need one to seven weekdays (Sunday = 0)');
    const weekdays = input.weekdays.map((day)=>integer(day, 0, 6, 'weekday')).sort();
    if (new Set(weekdays).size !== weekdays.length) throw invalid('Duplicate weekdays');
    return {
        kind,
        time: input.time,
        timezone: zone,
        weekdays
    };
}
function formatter(zone) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    });
}
function wallAt(format, time) {
    const values = {};
    for (const part of format.formatToParts(time))if (part.type !== 'literal') values[part.type] = Number(part.value);
    return values;
}
const wallEpoch = (wall)=>Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
function wallInstant(format, year, month, day, hour, minute) {
    const naive = Date.UTC(year, month - 1, day, hour, minute);
    const offsets = new Set();
    for(let hours = -36; hours <= 36; hours += 6){
        const sample = naive + hours * 3_600_000;
        offsets.add(wallEpoch(wallAt(format, sample)) - sample);
    }
    const candidates = [
        ...offsets
    ].map((offset)=>naive - offset).filter((candidate)=>{
        const actual = wallAt(format, candidate);
        return actual.year === year && actual.month === month && actual.day === day && actual.hour === hour && actual.minute === minute;
    });
    return candidates.length ? Math.min(...candidates) : null;
}
function occurrence(cadence, at, direction, inclusive) {
    const time = new Date(at).getTime();
    const matches = (candidate)=>direction === 1 ? inclusive ? candidate >= time : candidate > time : inclusive ? candidate <= time : candidate < time;
    if (cadence.kind === 'once') return matches(new Date(cadence.at).getTime()) ? cadence.at : null;
    const format = formatter(cadence.timezone);
    const wall = wallAt(format, time);
    const start = Date.UTC(wall.year, wall.month - 1, wall.day);
    const [hour, minute] = cadence.time.split(':').map(Number);
    for(let days = 0; days < 370; days++){
        const date = new Date(start + direction * days * 86_400_000);
        if (date.getUTCFullYear() < 1970 || date.getUTCFullYear() > 2099) return null;
        if (cadence.kind === 'weekly' && !cadence.weekdays.includes(date.getUTCDay())) continue;
        const candidate = wallInstant(format, date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute);
        if (candidate !== null && matches(candidate)) return new Date(candidate).toISOString();
    }
    return null;
}
export function nextScheduleOccurrence(cadence, after, inclusive = false) {
    return occurrence(validateScheduleCadence(cadence), instant(after), 1, inclusive);
}
export function previousScheduleOccurrence(cadence, before, inclusive = true) {
    return occurrence(validateScheduleCadence(cadence), instant(before), -1, inclusive);
}
