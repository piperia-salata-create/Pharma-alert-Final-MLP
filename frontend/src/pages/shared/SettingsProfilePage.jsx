import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useLanguage } from '../../contexts/LanguageContext';
import { supabase } from '../../lib/supabase';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Textarea } from '../../components/ui/textarea';
import { Switch } from '../../components/ui/switch';
import { toast } from 'sonner';
import { ArrowLeft, Mail, User, Building2, Shield, Clock, ChevronDown, MapPin } from 'lucide-react';

const dayOrder = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const jsDayOrder = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dayLabels = {
  en: { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' },
  el: { mon: 'Δευ', tue: 'Τρι', wed: 'Τετ', thu: 'Πεμ', fri: 'Παρ', sat: 'Σαβ', sun: 'Κυρ' }
};

const createEmptySchedule = () => dayOrder.reduce((acc, key) => {
  acc[key] = { closed: true, open: '', close: '' };
  return acc;
}, {});

const emptyForm = {
  full_name: '',
  email: ''
};

const emptyPharmacyForm = {
  name: '',
  address: '',
  phone: '',
  is_on_call: false,
  on_call_schedule: ''
};

const buildTimeOptions = () => {
  const options = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let minute = 0; minute < 60; minute += 15) {
      const h = String(hour).padStart(2, '0');
      const m = String(minute).padStart(2, '0');
      options.push(`${h}:${m}`);
    }
  }
  return options;
};

const timeOptions = buildTimeOptions();
const GEOCODE_MIN_QUERY_LENGTH = 4;
const GEOCODE_DEBOUNCE_MS = 500;
const GEOCODE_MIN_INTERVAL_MS = 1100;

const parseStructuredHours = (raw) => {
  if (!raw || typeof raw !== 'string') {
    return { schedule: createEmptySchedule(), legacy: '' };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { schedule: createEmptySchedule(), legacy: raw };
    }

    const schedule = createEmptySchedule();
    dayOrder.forEach((day) => {
      const entry = parsed[day] || {};
      const openValue = typeof entry.open === 'string' ? entry.open : '';
      const closeValue = typeof entry.close === 'string' ? entry.close : '';
      const hasTimes = openValue && closeValue;
      schedule[day] = {
        closed: entry.closed === true || !hasTimes,
        open: hasTimes ? openValue : '',
        close: hasTimes ? closeValue : ''
      };
    });

    return { schedule, legacy: '' };
  } catch (err) {
    return { schedule: createEmptySchedule(), legacy: raw };
  }
};

const timeToMinutes = (time) => {
  if (!time) return null;
  const [hours, minutes] = time.split(':').map((part) => Number(part));
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
};

const isScheduleEqual = (a, b) => {
  return dayOrder.every((day) => {
    const first = a?.[day] || { closed: true, open: '', close: '' };
    const second = b?.[day] || { closed: true, open: '', close: '' };
    return (
      Boolean(first.closed) === Boolean(second.closed)
      && (first.open || '') === (second.open || '')
      && (first.close || '') === (second.close || '')
    );
  });
};

const cloneSchedule = (schedule) => dayOrder.reduce((acc, day) => {
  const entry = schedule?.[day] || { closed: true, open: '', close: '' };
  acc[day] = {
    closed: Boolean(entry.closed),
    open: entry.open || '',
    close: entry.close || ''
  };
  return acc;
}, {});
export default function SettingsProfilePage() {
  const { user, profile, loading: authLoading, isPharmacist, fetchProfile } = useAuth();
  const { t, language } = useLanguage();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ ...emptyForm });
  const [originalProfile, setOriginalProfile] = useState({ ...emptyForm });
  const [profileData, setProfileData] = useState(null);
  const [formError, setFormError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [pharmacyLoading, setPharmacyLoading] = useState(true);
  const [pharmacyForm, setPharmacyForm] = useState({ ...emptyPharmacyForm });
  const [pharmacyOriginal, setPharmacyOriginal] = useState({ ...emptyPharmacyForm });
  const [pharmacyErrors, setPharmacyErrors] = useState({});
  const [pharmacyFormError, setPharmacyFormError] = useState('');
  const [existingPharmacyId, setExistingPharmacyId] = useState(null);
  const [originalPharmacyId, setOriginalPharmacyId] = useState(null);
  const [existingCoords, setExistingCoords] = useState({ latitude: null, longitude: null });
  const [originalCoords, setOriginalCoords] = useState({ latitude: null, longitude: null });
  const [pendingCoords, setPendingCoords] = useState(null);
  const [hoursSchedule, setHoursSchedule] = useState(createEmptySchedule());
  const [originalHoursSchedule, setOriginalHoursSchedule] = useState(createEmptySchedule());
  const [legacyHours, setLegacyHours] = useState('');
  const [originalLegacyHours, setOriginalLegacyHours] = useState('');
  const [geocodeResults, setGeocodeResults] = useState([]);
  const [geocodeLoading, setGeocodeLoading] = useState(false);
  const [geocodeError, setGeocodeError] = useState('');
  const [geocodeEmpty, setGeocodeEmpty] = useState(false);
  const [usingLocation, setUsingLocation] = useState(false);
  const [expandedDay, setExpandedDay] = useState(() => {
    return jsDayOrder[new Date().getDay()] || null;
  });
  const geocodeAbortRef = useRef(null);
  const geocodeTimerRef = useRef(null);
  const suppressGeocodeRef = useRef(false);
  const lastGeocodeAtRef = useRef(0);

  const basePath = isPharmacist() ? '/pharmacist' : '/patient';
  const isPharmacistRole = (profileData?.role || profile?.role) === 'pharmacist';
  const isEditMode = useMemo(() => Boolean(existingPharmacyId), [existingPharmacyId]);
  const labels = language === 'el' ? dayLabels.el : dayLabels.en;
  const roleLabel = useMemo(() => {
    if (profileData?.role === 'pharmacist' || profile?.role === 'pharmacist') return t('pharmacist');
    if (profileData?.role === 'patient' || profile?.role === 'patient') return t('patient');
    return '-';
  }, [profileData, profile, t]);
  const todayKey = useMemo(() => jsDayOrder[new Date().getDay()] || null, []);
  const getDaySummary = useCallback((entry) => {
    if (!entry || entry.closed) {
      return language === 'el' ? 'Κλειστό' : 'Closed';
    }
    if (entry.open && entry.close) {
      return `${entry.open} - ${entry.close}`;
    }
    return '--';
  }, [language]);

  const applyProfile = useCallback((data) => {
    if (!data) return;
    setProfileData(data);
    const nextForm = {
      full_name: data.full_name || '',
      email: data.email || user?.email || ''
    };
    setForm(nextForm);
    setOriginalProfile(nextForm);
  }, [user]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) return;

    const loadProfile = async () => {
      setLoading(true);
      setFormError('');
      setSuccessMessage('');
      try {
        const { data, error } = await supabase
          .from('profiles')
          .select('id,email,role,full_name,pharmacy_name,language')
          .eq('id', user.id)
          .single();

        if (error) {
          if (error.code === 'PGRST116') {
            const createdProfile = await fetchProfile(user.id, 'settingsProfile');
            if (createdProfile) {
              applyProfile(createdProfile);
              return;
            }
          }
          throw error;
        }

        applyProfile(data);
      } catch (err) {
        console.error('Failed to load profile:', err);
        const message = err?.message || (language === 'el' ? 'Σφάλμα φόρτωσης.' : 'Failed to load profile.');
        setFormError(message);
        if (profile) {
          applyProfile(profile);
        }
      } finally {
        setLoading(false);
      }
    };

    loadProfile();
  }, [authLoading, user, profile, language, fetchProfile, applyProfile]);

  useEffect(() => {
    if (authLoading) return;
    if (!user || !isPharmacistRole) {
      setPharmacyLoading(false);
      return;
    }

    const loadPharmacy = async () => {
      setPharmacyLoading(true);
      setPharmacyFormError('');
      try {
        const { data, error } = await supabase
          .from('pharmacies')
          .select('*')
          .eq('owner_id', user.id)
          .limit(1)
          .maybeSingle();

        if (error) throw error;

        if (data) {
          setExistingPharmacyId(data.id);
          setOriginalPharmacyId(data.id);
          setExistingCoords({
            latitude: data.latitude ?? null,
            longitude: data.longitude ?? null
          });
          setOriginalCoords({
            latitude: data.latitude ?? null,
            longitude: data.longitude ?? null
          });
          setPendingCoords(null);
          setPharmacyForm({
            name: data.name || '',
            address: data.address || '',
            phone: data.phone || '',
            is_on_call: Boolean(data.is_on_call),
            on_call_schedule: data.on_call_schedule || ''
          });
          setPharmacyOriginal({
            name: data.name || '',
            address: data.address || '',
            phone: data.phone || '',
            is_on_call: Boolean(data.is_on_call),
            on_call_schedule: data.on_call_schedule || ''
          });
          const parsed = parseStructuredHours(data.hours);
          setHoursSchedule(parsed.schedule);
          setOriginalHoursSchedule(parsed.schedule);
          setLegacyHours(parsed.legacy);
          setOriginalLegacyHours(parsed.legacy);
        } else {
          setExistingPharmacyId(null);
          setOriginalPharmacyId(null);
          setExistingCoords({ latitude: null, longitude: null });
          setOriginalCoords({ latitude: null, longitude: null });
          setPendingCoords(null);
          setPharmacyForm({ ...emptyPharmacyForm });
          setPharmacyOriginal({ ...emptyPharmacyForm });
          setHoursSchedule(createEmptySchedule());
          setOriginalHoursSchedule(createEmptySchedule());
          setLegacyHours('');
          setOriginalLegacyHours('');
        }
      } catch (err) {
        const message = err?.message || (language === 'el' ? 'Σφάλμα φόρτωσης.' : 'Failed to load.');
        setPharmacyFormError(message);
      } finally {
        setPharmacyLoading(false);
      }
    };

    loadPharmacy();
  }, [authLoading, user, isPharmacistRole, language]);

  const handleChange = (field) => (eventOrValue) => {
    const value = eventOrValue?.target ? eventOrValue.target.value : eventOrValue;
    setForm((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const handlePharmacyChange = (field) => (eventOrValue) => {
    const value = eventOrValue?.target ? eventOrValue.target.value : eventOrValue;
    if (field === 'address' && !suppressGeocodeRef.current) {
      setPendingCoords(null);
    }
    setPharmacyForm((prev) => ({
      ...prev,
      [field]: value
    }));
  };

  const updateDay = (dayKey, updates) => {
    setHoursSchedule((prev) => ({
      ...prev,
      [dayKey]: {
        ...prev[dayKey],
        ...updates
      }
    }));
    setPharmacyErrors((prev) => {
      if (!prev.hours) return prev;
      const { hours, ...rest } = prev;
      return rest;
    });
  };

  const validatePharmacy = () => {
    const nextErrors = {};
    if (!pharmacyForm.name.trim()) {
      nextErrors.name = language === 'el' ? 'Απαιτείται όνομα.' : 'Name is required.';
    }
    if (!pharmacyForm.address.trim()) {
      nextErrors.address = language === 'el' ? 'Απαιτείται διεύθυνση.' : 'Address is required.';
    }
    setPharmacyErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const getHoursPayload = () => {
    let anyOpenDay = false;
    let anyTimeSet = false;
    let hasError = false;

    const schedule = {};

    dayOrder.forEach((day) => {
      const entry = hoursSchedule[day] || { closed: true, open: '', close: '' };
      const openValue = entry.open || '';
      const closeValue = entry.close || '';

      if (openValue || closeValue) {
        anyTimeSet = true;
      }

      if (entry.closed) {
        schedule[day] = { closed: true, open: null, close: null };
        return;
      }

      anyOpenDay = true;
      if (!openValue || !closeValue) {
        hasError = true;
        schedule[day] = { closed: false, open: openValue || null, close: closeValue || null };
        return;
      }

      const openMinutes = timeToMinutes(openValue);
      const closeMinutes = timeToMinutes(closeValue);
      if (openMinutes === null || closeMinutes === null || closeMinutes <= openMinutes) {
        hasError = true;
      }

      schedule[day] = { closed: false, open: openValue, close: closeValue };
    });

    if (!anyOpenDay && !anyTimeSet) {
      if (legacyHours) {
        return { hoursValue: legacyHours, error: '' };
      }
      return { hoursValue: null, error: '' };
    }

    if (hasError) {
      return {
        hoursValue: null,
        error: language === 'el'
          ? 'Ελέγξτε τις ώρες λειτουργίας. Το κλείσιμο πρέπει να είναι μετά το άνοιγμα.'
          : 'Check the opening hours. Closing time must be later than opening time.'
      };
    }

    return { hoursValue: JSON.stringify(schedule), error: '' };
  };

  const waitForGeocodeRateLimit = async () => {
    const elapsed = Date.now() - lastGeocodeAtRef.current;
    const delay = Math.max(GEOCODE_MIN_INTERVAL_MS - elapsed, 0);
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
    lastGeocodeAtRef.current = Date.now();
  };

  const searchNominatim = async (query, limit = 5, signal) => {
    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('format', 'json');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('dedupe', '1');

    const response = await fetch(url.toString(), {
      signal,
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`Geocode failed (${response.status})`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) return [];

    return data.map((item) => ({
      id: item.place_id,
      displayName: item.display_name,
      latitude: Number(item.lat),
      longitude: Number(item.lon)
    })).filter((item) => !Number.isNaN(item.latitude) && !Number.isNaN(item.longitude));
  };

  const geocodeAddress = async (address) => {
    const trimmed = address.trim();
    if (!trimmed) return { latitude: null, longitude: null, status: 'empty' };
    try {
      await waitForGeocodeRateLimit();
      const results = await searchNominatim(trimmed, 1);
      if (results.length > 0) {
        return { latitude: results[0].latitude, longitude: results[0].longitude, status: 'ok' };
      }
      return { latitude: null, longitude: null, status: 'not_found' };
    } catch (err) {
      console.error('Geocode failed:', err);
      return { latitude: null, longitude: null, status: 'error' };
    }
  };

  useEffect(() => {
    if (!isPharmacistRole) return;
    const query = pharmacyForm.address.trim();
    if (suppressGeocodeRef.current) {
      suppressGeocodeRef.current = false;
      return;
    }

    if (query.length < GEOCODE_MIN_QUERY_LENGTH) {
      setGeocodeResults([]);
      setGeocodeError('');
      setGeocodeEmpty(false);
      setGeocodeLoading(false);
      if (geocodeAbortRef.current) {
        geocodeAbortRef.current.abort();
      }
      return;
    }

    if (geocodeTimerRef.current) {
      clearTimeout(geocodeTimerRef.current);
    }

    geocodeTimerRef.current = setTimeout(async () => {
      if (geocodeAbortRef.current) {
        geocodeAbortRef.current.abort();
      }
      const abortController = new AbortController();
      geocodeAbortRef.current = abortController;
      setGeocodeLoading(true);
      setGeocodeError('');
      try {
        await waitForGeocodeRateLimit();
        const results = await searchNominatim(query, 5, abortController.signal);
        if (abortController.signal.aborted) return;
        setGeocodeResults(results);
        setGeocodeEmpty(results.length === 0);
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error('Geocode search failed:', err);
        setGeocodeError(language === 'el' ? '\u0391\u03c0\u03bf\u03c4\u03c5\u03c7\u03af\u03b1 \u03b1\u03bd\u03b1\u03b6\u03ae\u03c4\u03b7\u03c3\u03b7\u03c2.' : 'Search failed.');
        setGeocodeResults([]);
        setGeocodeEmpty(true);
      } finally {
        if (!abortController.signal.aborted) {
          setGeocodeLoading(false);
        }
      }
    }, GEOCODE_DEBOUNCE_MS);

    return () => {
      if (geocodeTimerRef.current) {
        clearTimeout(geocodeTimerRef.current);
      }
      if (geocodeAbortRef.current) {
        geocodeAbortRef.current.abort();
      }
    };
  }, [pharmacyForm.address, isPharmacistRole, language]);

  const selectGeocodeResult = (result) => {
    if (!result) return;
    suppressGeocodeRef.current = true;
    setPharmacyForm((prev) => ({
      ...prev,
      address: result.displayName
    }));
    setPendingCoords({
      latitude: result.latitude,
      longitude: result.longitude,
      source: 'search'
    });
    setGeocodeResults([]);
    setGeocodeEmpty(false);
    setGeocodeError('');
  };

  const useMyLocation = () => {
    if (!navigator?.geolocation) {
      toast.error(language === 'el' ? '\u0397 \u03b3\u03b5\u03c9\u03b5\u03bd\u03c4\u03cc\u03c0\u03b9\u03c3\u03b7 \u03b4\u03b5\u03bd \u03c5\u03c0\u03bf\u03c3\u03c4\u03b7\u03c1\u03af\u03b6\u03b5\u03c4\u03b1\u03b9.' : 'Geolocation is not supported.');
      return;
    }
    setUsingLocation(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setPendingCoords({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          source: 'device'
        });
        setGeocodeResults([]);
        setGeocodeEmpty(false);
        setGeocodeError('');
        toast.success(language === 'el' ? '\u0397 \u03c4\u03bf\u03c0\u03bf\u03b8\u03b5\u03c3\u03af\u03b1 \u03c3\u03b1\u03c2 \u03ba\u03b1\u03c4\u03b1\u03c7\u03c9\u03c1\u03ae\u03b8\u03b7\u03ba\u03b5.' : 'Location captured.');
        setUsingLocation(false);
      },
      (error) => {
        console.error('Geolocation failed:', error);
        toast.error(language === 'el' ? '\u0391\u03c0\u03bf\u03c4\u03c5\u03c7\u03af\u03b1 \u03bb\u03ae\u03c8\u03b7\u03c2 \u03c4\u03bf\u03c0\u03bf\u03b8\u03b5\u03c3\u03af\u03b1\u03c2.' : 'Unable to get location.');
        setUsingLocation(false);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  };

  const profileHasChanges = useMemo(() => {
    return (
      form.full_name.trim() !== originalProfile.full_name.trim()
      || form.email.trim() !== originalProfile.email.trim()
    );
  }, [form, originalProfile]);

  const pharmacyHasChanges = useMemo(() => {
    if (!isPharmacistRole) return false;
    const coordsChanged = pendingCoords
      && ((pendingCoords.latitude ?? null) !== (existingCoords.latitude ?? null)
        || (pendingCoords.longitude ?? null) !== (existingCoords.longitude ?? null));
    return (
      pharmacyForm.name.trim() !== pharmacyOriginal.name.trim()
      || pharmacyForm.address.trim() !== pharmacyOriginal.address.trim()
      || pharmacyForm.phone.trim() !== pharmacyOriginal.phone.trim()
      || Boolean(pharmacyForm.is_on_call) !== Boolean(pharmacyOriginal.is_on_call)
      || pharmacyForm.on_call_schedule.trim() !== pharmacyOriginal.on_call_schedule.trim()
      || !isScheduleEqual(hoursSchedule, originalHoursSchedule)
      || coordsChanged
    );
  }, [
    isPharmacistRole,
    pharmacyForm,
    pharmacyOriginal,
    hoursSchedule,
    originalHoursSchedule,
    pendingCoords,
    existingCoords
  ]);

  const hasAnyChanges = profileHasChanges || pharmacyHasChanges;

  const handleSave = async () => {
    if (!user) return;
    if (!hasAnyChanges) {
      toast(language === 'el' ? 'Δεν υπάρχουν αλλαγές.' : 'No changes to save.');
      return;
    }

    setSaving(true);
    setFormError('');
    setPharmacyFormError('');
    setSuccessMessage('');

    let didSave = false;
    let profileError = false;
    let pharmacyError = false;

    if (profileHasChanges) {
      const profileUpdates = {};
      const trimmedName = form.full_name.trim();
      const trimmedEmail = form.email.trim();

      if (trimmedName !== originalProfile.full_name.trim()) {
        profileUpdates.full_name = trimmedName;
      }
      if (trimmedEmail !== originalProfile.email.trim()) {
        profileUpdates.email = trimmedEmail;
      }

      if (Object.keys(profileUpdates).length > 0) {
        profileUpdates.updated_at = new Date().toISOString();
        try {
          const { error } = await supabase
            .from('profiles')
            .update(profileUpdates)
            .eq('id', user.id);

          if (error) throw error;

          const nextProfile = {
            full_name: trimmedName,
            email: trimmedEmail
          };
          setOriginalProfile(nextProfile);
          setForm(nextProfile);
          setProfileData((prev) => ({
            ...(prev || {}),
            ...nextProfile
          }));
          didSave = true;

          if (profileUpdates.email && supabase?.auth?.updateUser) {
            const { error: authError } = await supabase.auth.updateUser({ email: trimmedEmail });
            if (authError) {
              toast(language === 'el'
                ? 'Το email προφίλ ενημερώθηκε, αλλά το email σύνδεσης ίσως χρειάζεται ξεχωριστή ενημέρωση.'
                : 'Profile email saved, but login email may require a separate auth update.');
            }
          } else if (profileUpdates.email && !supabase?.auth?.updateUser) {
            toast(language === 'el'
              ? 'Το email προφίλ ενημερώθηκε, αλλά το email σύνδεσης ίσως χρειάζεται ξεχωριστή ενημέρωση.'
              : 'Profile email saved, but login email may require a separate auth update.');
          }

          await fetchProfile(user.id, 'settingsProfile:save');
        } catch (err) {
          console.error('Failed to update profile:', err);
          const message = (err?.status === 403 || err?.code === '42501')
            ? (language === 'el'
              ? 'Δεν έχετε δικαίωμα ενημέρωσης προφίλ.'
              : 'You do not have permission to update your profile.')
            : (err?.message || (language === 'el' ? 'Αποτυχία ενημέρωσης.' : 'Update failed.'));
          setFormError(message);
          toast.error(message);
          profileError = true;
        }
      }
    }

    if (pharmacyHasChanges && isPharmacistRole) {
      setPharmacyFormError('');
      if (!validatePharmacy()) {
        pharmacyError = true;
      } else {
        const scheduleChanged = !isScheduleEqual(hoursSchedule, originalHoursSchedule);
        let hoursValue = null;
        if (!isEditMode || scheduleChanged) {
          const hoursPayload = getHoursPayload();
          if (hoursPayload.error) {
            setPharmacyErrors((prev) => ({ ...prev, hours: hoursPayload.error }));
            pharmacyError = true;
          } else {
            hoursValue = hoursPayload.hoursValue;
          }
        }

        if (!pharmacyError) {
          try {
            const addressChanged = pharmacyForm.address.trim() !== pharmacyOriginal.address.trim();
            const nameChanged = pharmacyForm.name.trim() !== pharmacyOriginal.name.trim();
            const phoneChanged = pharmacyForm.phone.trim() !== pharmacyOriginal.phone.trim();
            const onCallChanged = Boolean(pharmacyForm.is_on_call) !== Boolean(pharmacyOriginal.is_on_call);
            const onCallScheduleChanged = pharmacyForm.on_call_schedule.trim()
              !== pharmacyOriginal.on_call_schedule.trim();
            const coordsChanged = pendingCoords
              && ((pendingCoords.latitude ?? null) !== (existingCoords.latitude ?? null)
                || (pendingCoords.longitude ?? null) !== (existingCoords.longitude ?? null));

            let geocodeResult = { latitude: existingCoords.latitude, longitude: existingCoords.longitude, status: 'ok' };
            if (pendingCoords) {
              geocodeResult = {
                latitude: pendingCoords.latitude,
                longitude: pendingCoords.longitude,
                status: 'ok'
              };
            } else if (!isEditMode || addressChanged) {
              geocodeResult = await geocodeAddress(pharmacyForm.address);
            }

            let latitudeValue = geocodeResult.latitude;
            let longitudeValue = geocodeResult.longitude;
            const geocodeFailed = geocodeResult.status !== 'ok';

            if (geocodeFailed && isEditMode) {
              latitudeValue = existingCoords.latitude;
              longitudeValue = existingCoords.longitude;
            }

            if (isEditMode) {
              const updates = {};
              if (nameChanged) updates.name = pharmacyForm.name.trim();
              if (addressChanged) updates.address = pharmacyForm.address.trim();
              if (phoneChanged) updates.phone = pharmacyForm.phone.trim() || null;
              if (scheduleChanged) updates.hours = hoursValue;
              if (onCallChanged) updates.is_on_call = Boolean(pharmacyForm.is_on_call);
              if (onCallScheduleChanged) {
                updates.on_call_schedule = pharmacyForm.on_call_schedule.trim() || null;
              }
              if (addressChanged || coordsChanged) {
                updates.latitude = latitudeValue;
                updates.longitude = longitudeValue;
              }

              if (Object.keys(updates).length > 0) {
                const { error } = await supabase
                  .from('pharmacies')
                  .update(updates)
                  .eq('id', existingPharmacyId);

                if (error) {
                  if (error.status === 403 || error.code === '42501') {
                    const message = language === 'el'
                      ? 'Δεν έχετε δικαίωμα να ενημερώσετε το φαρμακείο.'
                      : 'You do not have permission to update the pharmacy.';
                    setPharmacyFormError(message);
                    toast.error(message);
                    pharmacyError = true;
                  } else {
                    throw error;
                  }
                } else {
                  didSave = true;
                }
              }
            } else {
              const ownerId = user?.id || null;
              if (!ownerId) {
                const message = language === 'el'
                  ? 'Δεν βρέθηκε ο χρήστης για την καταχώρηση.'
                  : 'User not found for this request.';
                setPharmacyFormError(message);
                toast.error(message);
                pharmacyError = true;
              } else {
                const { data, error } = await supabase
                  .from('pharmacies')
                  .insert({
                    owner_id: ownerId,
                    name: pharmacyForm.name.trim(),
                    address: pharmacyForm.address.trim(),
                    phone: pharmacyForm.phone.trim() || null,
                    hours: hoursValue,
                    is_on_call: Boolean(pharmacyForm.is_on_call),
                    on_call_schedule: pharmacyForm.on_call_schedule.trim() || null,
                    latitude: latitudeValue,
                    longitude: longitudeValue
                  })
                  .select('id')
                  .single();

                if (error) {
                  if (error.status === 403 || error.code === '42501') {
                    const message = language === 'el'
                      ? 'Δεν έχετε δικαίωμα να δημιουργήσετε φαρμακείο.'
                      : 'You do not have permission to create a pharmacy.';
                    setPharmacyFormError(message);
                    toast.error(message);
                    pharmacyError = true;
                  } else {
                    throw error;
                  }
                } else {
                  setExistingPharmacyId(data?.id || null);
                  setOriginalPharmacyId(data?.id || null);
                  setExistingCoords({ latitude: latitudeValue ?? null, longitude: longitudeValue ?? null });
                  setOriginalCoords({ latitude: latitudeValue ?? null, longitude: longitudeValue ?? null });
                  setPendingCoords(null);
                  const nextPharmacy = {
                    name: pharmacyForm.name.trim(),
                    address: pharmacyForm.address.trim(),
                    phone: pharmacyForm.phone.trim(),
                    is_on_call: Boolean(pharmacyForm.is_on_call),
                    on_call_schedule: pharmacyForm.on_call_schedule.trim()
                  };
                  setPharmacyOriginal(nextPharmacy);
                  setPharmacyForm(nextPharmacy);
                  setOriginalHoursSchedule(cloneSchedule(hoursSchedule));
                  if (hoursValue === null || (typeof hoursValue === 'string' && hoursValue.trim().startsWith('{'))) {
                    setLegacyHours('');
                    setOriginalLegacyHours('');
                  }
                  didSave = true;
                }
              }
            }

            if (!pharmacyError && isEditMode && addressChanged) {
              setExistingCoords({ latitude: latitudeValue ?? null, longitude: longitudeValue ?? null });
              setOriginalCoords({ latitude: latitudeValue ?? null, longitude: longitudeValue ?? null });
              setPendingCoords(null);
            }

            if (!pharmacyError && isEditMode) {
              const nextPharmacy = {
                name: pharmacyForm.name.trim(),
                address: pharmacyForm.address.trim(),
                phone: pharmacyForm.phone.trim(),
                is_on_call: Boolean(pharmacyForm.is_on_call),
                on_call_schedule: pharmacyForm.on_call_schedule.trim()
              };
              setPharmacyOriginal(nextPharmacy);
              setPharmacyForm(nextPharmacy);
              if (coordsChanged) {
                setExistingCoords({ latitude: latitudeValue ?? null, longitude: longitudeValue ?? null });
                setOriginalCoords({ latitude: latitudeValue ?? null, longitude: longitudeValue ?? null });
                setPendingCoords(null);
              }
              if (scheduleChanged) {
                setOriginalHoursSchedule(cloneSchedule(hoursSchedule));
                if (hoursValue === null || (typeof hoursValue === 'string' && hoursValue.trim().startsWith('{'))) {
                  setLegacyHours('');
                  setOriginalLegacyHours('');
                }
              }
            }

            if (!pharmacyError && geocodeResult.status !== 'ok' && (addressChanged || !isEditMode)) {
              toast(language === 'el'
                ? 'Η διεύθυνση αποθηκεύτηκε, αλλά δεν εντοπίστηκε τοποθεσία.'
                : 'Address saved but location could not be detected.');
            }
          } catch (err) {
            console.error('Pharmacy save failed:', err);
            const message = err?.message || (language === 'el' ? 'Κάτι πήγε στραβά.' : 'Something went wrong.');
            setPharmacyFormError(message);
            toast.error(message);
            pharmacyError = true;
          }
        }
      }
    }

    const hadError = profileError || pharmacyError;
    if (!hadError && didSave) {
      setSuccessMessage(language === 'el' ? 'Αποθηκεύτηκε.' : 'Saved.');
      toast.success(language === 'el' ? 'Οι αλλαγές αποθηκεύτηκαν.' : 'Changes saved.');
    }

    setSaving(false);
  };

  const handleCancel = () => {
    setForm({ ...originalProfile });
    setProfileData((prev) => ({
      ...(prev || {}),
      full_name: originalProfile.full_name,
      email: originalProfile.email
    }));
    setFormError('');
    setSuccessMessage('');
    setPharmacyForm({ ...pharmacyOriginal });
    setExistingPharmacyId(originalPharmacyId);
    setExistingCoords({ ...originalCoords });
    setPendingCoords(null);
    setHoursSchedule(cloneSchedule(originalHoursSchedule));
    setLegacyHours(originalLegacyHours);
    setPharmacyErrors({});
    setPharmacyFormError('');
    setGeocodeResults([]);
    setGeocodeError('');
    setGeocodeEmpty(false);
  };

  return (
    <div className="min-h-screen bg-pharma-ice-blue" data-testid="settings-profile-page">
      {/* Header */}
      <header className="sticky top-0 z-50 glass border-b border-pharma-grey-pale/50">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link to={`${basePath}/settings`}>
            <Button variant="ghost" size="sm" className="rounded-full h-9 w-9 p-0">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <h1 className="font-heading font-semibold text-pharma-dark-slate">
            {t('profile')}
          </h1>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-2xl mx-auto px-4 py-5 space-y-5">
        <section className="page-enter">
          <Card className="gradient-card rounded-xl shadow-sm border border-pharma-grey-pale/50 overflow-hidden">
            <CardContent className="p-5">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-xl bg-pharma-teal/10 flex items-center justify-center">
                  <User className="w-7 h-7 text-pharma-teal" />
                </div>
                <div className="min-w-0">
                  <h2 className="font-heading font-semibold text-pharma-dark-slate truncate">
                    {profileData?.full_name || profile?.full_name || user?.email || t('profile')}
                  </h2>
                  <p className="text-pharma-slate-grey text-sm truncate">
                    {profileData?.email || profile?.email || user?.email || '-'}
                  </p>
                  <p className="text-pharma-teal text-xs font-medium capitalize mt-0.5">
                    {roleLabel}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </section>

        <section className="page-enter stagger-1">
          <Card className="gradient-card rounded-xl shadow-sm border border-pharma-grey-pale/50 overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="font-heading text-lg text-pharma-dark-slate">
                {language === 'el' ? 'Επεξεργασία Προφίλ' : 'Edit Profile'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-5 space-y-6">
              {loading && (
                <div className="text-xs text-pharma-slate-grey">
                  {language === 'el' ? 'Φόρτωση...' : 'Loading...'}
                </div>
              )}
              {formError && (
                <div className="rounded-lg border border-pharma-coral/40 bg-pharma-coral/10 px-3 py-2 text-sm text-pharma-coral">
                  {formError}
                </div>
              )}
              {successMessage && (
                <div className="rounded-lg border border-pharma-sea-green/30 bg-pharma-sea-green/10 px-3 py-2 text-sm text-pharma-sea-green">
                  {successMessage}
                </div>
              )}

              <div className="space-y-4">
                <h3 className="text-sm font-semibold text-pharma-dark-slate">
                  {language === 'el' ? 'Στοιχεία Χρήστη' : 'User Details'}
                </h3>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-pharma-charcoal">
                    {language === 'el' ? 'Ονοματεπώνυμο' : 'Full name'}
                  </label>
                  <Input
                    value={form.full_name}
                    onChange={handleChange('full_name')}
                    placeholder={language === 'el' ? 'π.χ. Γιώργος Παπαδόπουλος' : 'e.g. Jane Doe'}
                    className="rounded-xl"
                    data-testid="profile-fullname-input"
                    disabled={loading}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium text-pharma-charcoal flex items-center gap-2">
                    <Mail className="w-4 h-4 text-pharma-steel-blue" />
                    {t('email')}
                  </label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={handleChange('email')}
                    placeholder={language === 'el' ? 'π.χ. name@email.gr' : 'e.g. name@email.com'}
                    className="rounded-xl"
                    data-testid="profile-email-input"
                    disabled={loading}
                  />
                </div>

                <div className="rounded-xl border border-pharma-grey-pale/60 bg-white">
                  <div className="flex items-center justify-between p-4">
                    <div className="flex items-center gap-3">
                      <div className="w-9 h-9 rounded-lg bg-pharma-teal/10 flex items-center justify-center">
                        <Shield className="w-5 h-5 text-pharma-teal" />
                      </div>
                      <span className="text-sm text-pharma-charcoal">
                        {language === 'el' ? 'Ρόλος' : 'Role'}
                      </span>
                    </div>
                    <span className="text-sm text-pharma-slate-grey truncate max-w-[55%]">
                      {roleLabel}
                    </span>
                  </div>
                </div>
              </div>

              {isPharmacistRole && (
                <div className="space-y-4 pt-2 border-t border-pharma-grey-pale/60">
                  <div className="flex items-center gap-2">
                    <Building2 className="w-5 h-5 text-pharma-teal" />
                    <h3 className="text-sm font-semibold text-pharma-dark-slate">
                      {language === 'el' ? 'Στοιχεία Φαρμακείου' : 'Pharmacy Details'}
                    </h3>
                  </div>

                  {isEditMode ? (
                    <div className="rounded-lg border border-pharma-grey-pale/70 bg-white px-3 py-2 text-xs text-pharma-slate-grey">
                      {language === 'el'
                        ? 'Έχετε ήδη φαρμακείο. Επεξεργάζετε τα υπάρχοντα στοιχεία.'
                        : 'You already have a pharmacy. You are editing the existing details.'}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-pharma-grey-pale/70 bg-white px-3 py-2 text-xs text-pharma-slate-grey">
                      {language === 'el'
                        ? 'Δεν υπάρχει ακόμη προφίλ φαρμακείου. Συμπληρώστε τα στοιχεία για να το δημιουργήσετε.'
                        : 'No pharmacy profile yet. Fill in the details to create it.'}
                    </div>
                  )}

                  {pharmacyFormError && (
                    <div className="rounded-lg border border-pharma-coral/40 bg-pharma-coral/10 px-3 py-2 text-sm text-pharma-coral">
                      {pharmacyFormError}
                    </div>
                  )}

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-pharma-charcoal">
                      {language === 'el' ? 'Όνομα *' : 'Name *'}
                    </label>
                    <Input
                      value={pharmacyForm.name}
                      onChange={handlePharmacyChange('name')}
                      placeholder={language === 'el' ? 'π.χ. Φαρμακείο Κέντρου' : 'e.g. City Pharmacy'}
                      className={`rounded-xl ${pharmacyErrors.name ? 'border-pharma-coral' : ''}`}
                      data-testid="pharmacy-name-input"
                      disabled={pharmacyLoading}
                    />
                    {pharmacyErrors.name && (
                      <p className="text-xs text-pharma-coral">{pharmacyErrors.name}</p>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-pharma-charcoal">
                      {language === 'el' ? '\u0394\u03b9\u03b5\u03cd\u03b8\u03c5\u03bd\u03c3\u03b7 *' : 'Address *'}
                    </label>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                      <Input
                        value={pharmacyForm.address}
                        onChange={handlePharmacyChange('address')}
                        placeholder={language === 'el' ? '\u039f\u03b4\u03cc\u03c2, \u03b1\u03c1\u03b9\u03b8\u03bc\u03cc\u03c2, \u03c0\u03cc\u03bb\u03b7' : 'Street, number, city'}
                        className={`rounded-xl ${pharmacyErrors.address ? 'border-pharma-coral' : ''} flex-1`}
                        data-testid="pharmacy-address-input"
                        disabled={pharmacyLoading}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        className="rounded-xl gap-2"
                        onClick={useMyLocation}
                        disabled={pharmacyLoading || usingLocation}
                        data-testid="pharmacy-use-location-btn"
                      >
                        <MapPin className="w-4 h-4" />
                        {usingLocation
                          ? (language === 'el' ? '\u039b\u03ae\u03c8\u03b7...' : 'Locating...')
                          : (language === 'el' ? '\u03a7\u03c1\u03ae\u03c3\u03b7 \u03c4\u03bf\u03c0\u03bf\u03b8\u03b5\u03c3\u03af\u03b1\u03c2' : 'Use my location')}
                      </Button>
                    </div>
                    {pharmacyErrors.address && (
                      <p className="text-xs text-pharma-coral">{pharmacyErrors.address}</p>
                    )}
                    {geocodeLoading && (
                      <p className="text-xs text-pharma-slate-grey">
                        {language === 'el' ? '\u0391\u03bd\u03b1\u03b6\u03ae\u03c4\u03b7\u03c3\u03b7 \u03b4\u03b9\u03b5\u03cd\u03b8\u03c5\u03bd\u03c3\u03b7\u03c2...' : 'Searching address...'}
                      </p>
                    )}
                    {geocodeError && (
                      <p className="text-xs text-pharma-coral">{geocodeError}</p>
                    )}
                    {geocodeResults.length > 0 && (
                      <div className="rounded-xl border border-pharma-grey-pale/70 bg-white overflow-hidden">
                        {geocodeResults.map((result) => (
                          <button
                            key={result.id}
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm text-pharma-charcoal hover:bg-pharma-ice-blue/60"
                            onClick={() => selectGeocodeResult(result)}
                          >
                            <div className="text-sm text-pharma-charcoal">{result.displayName}</div>
                            <div className="text-[11px] text-pharma-slate-grey">
                              {result.latitude.toFixed(5)}, {result.longitude.toFixed(5)}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                    {geocodeEmpty && !geocodeLoading && !geocodeError && (
                      <p className="text-xs text-pharma-slate-grey">
                        {language === 'el' ? '\u0394\u03b5\u03bd \u03b2\u03c1\u03ad\u03b8\u03b7\u03ba\u03b1\u03bd \u03b1\u03c0\u03bf\u03c4\u03b5\u03bb\u03ad\u03c3\u03bc\u03b1\u03c4\u03b1.' : 'No results found.'}
                      </p>
                    )}
                    {pendingCoords && (
                      <div className="flex items-center gap-2 text-xs text-pharma-sea-green">
                        <MapPin className="w-3 h-3" />
                        <span>
                          {pendingCoords.source === 'device'
                            ? (language === 'el' ? '\u039f\u03c1\u03af\u03c3\u03c4\u03b7\u03ba\u03b5 \u03b1\u03c0\u03cc \u03c4\u03b7\u03bd \u03c4\u03bf\u03c0\u03bf\u03b8\u03b5\u03c3\u03af\u03b1 \u03c3\u03b1\u03c2.' : 'Set from your location.')
                            : (language === 'el' ? '\u039f\u03c1\u03af\u03c3\u03c4\u03b7\u03ba\u03b5 \u03b1\u03c0\u03cc \u03c4\u03b7\u03bd \u03b1\u03bd\u03b1\u03b6\u03ae\u03c4\u03b7\u03c3\u03b7.' : 'Set from search.')}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-pharma-charcoal">
                      {language === 'el' ? 'Τηλέφωνο' : 'Phone'}
                    </label>
                    <Input
                      value={pharmacyForm.phone}
                      onChange={handlePharmacyChange('phone')}
                      placeholder={language === 'el' ? 'π.χ. 2101234567' : 'e.g. +30 210 1234567'}
                      className="rounded-xl"
                      data-testid="pharmacy-phone-input"
                      disabled={pharmacyLoading}
                    />
                  </div>

                  <section className="space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-medium text-pharma-charcoal">
                          {language === 'el' ? 'Ωράριο λειτουργίας' : 'Opening hours'}
                        </h3>
                        <p className="text-xs text-pharma-slate-grey">
                          {language === 'el' ? 'Ορίστε ώρες ανά ημέρα.' : 'Set opening hours per day.'}
                        </p>
                      </div>
                    </div>

                    {legacyHours && (
                      <div className="rounded-lg border border-pharma-coral/40 bg-pharma-coral/10 px-3 py-2 text-xs text-pharma-coral">
                        {language === 'el'
                          ? 'Εισαγωγή από παλιό κείμενο ωραρίου.'
                          : 'Imported from legacy hours text.'}
                        <div className="mt-1 text-sm text-pharma-charcoal">
                          {legacyHours}
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      {dayOrder.map((day) => {
                        const entry = hoursSchedule[day];
                        const isExpanded = expandedDay === day;
                        const summary = getDaySummary(entry);
                        return (
                          <div key={day} className="rounded-xl border border-pharma-grey-pale/60 bg-white overflow-hidden">
                            <button
                              type="button"
                              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
                              onClick={() => setExpandedDay((prev) => (prev === day ? null : day))}
                            >
                              <div className="flex items-center gap-3">
                                <div>
                                  <p className="text-sm font-medium text-pharma-charcoal">{labels[day]}</p>
                                  <p className="text-xs text-pharma-slate-grey">{summary}</p>
                                </div>
                                {todayKey === day && (
                                  <span className="text-[11px] font-medium uppercase tracking-wide text-pharma-teal bg-pharma-teal/10 px-2 py-0.5 rounded-full">
                                    {language === 'el' ? 'Σήμερα' : 'Today'}
                                  </span>
                                )}
                              </div>
                              <ChevronDown
                                className={`w-4 h-4 text-pharma-slate-grey transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                              />
                            </button>
                            {isExpanded && (
                              <div className="border-t border-pharma-grey-pale/60 p-3 space-y-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs text-pharma-slate-grey">
                                    {language === 'el' ? 'Κλειστό' : 'Closed'}
                                  </span>
                                  <Switch
                                    checked={entry.closed}
                                    onCheckedChange={(checked) => updateDay(day, {
                                      closed: checked,
                                      open: checked ? '' : entry.open,
                                      close: checked ? '' : entry.close
                                    })}
                                    data-testid={`hours-closed-${day}`}
                                    disabled={pharmacyLoading}
                                  />
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                  <div className="space-y-1">
                                    <label className="text-xs text-pharma-slate-grey">
                                      {language === 'el' ? 'Άνοιγμα' : 'Opens'}
                                    </label>
                                    <select
                                      className="h-10 w-full rounded-xl border border-pharma-grey-pale bg-white px-3 text-sm text-pharma-charcoal"
                                      value={entry.open}
                                      onChange={(event) => updateDay(day, { open: event.target.value })}
                                      disabled={pharmacyLoading || entry.closed}
                                    >
                                      <option value="">--</option>
                                      {timeOptions.map((time) => (
                                        <option key={`${day}-open-${time}`} value={time}>{time}</option>
                                      ))}
                                    </select>
                                  </div>
                                  <div className="space-y-1">
                                    <label className="text-xs text-pharma-slate-grey">
                                      {language === 'el' ? 'Κλείσιμο' : 'Closes'}
                                    </label>
                                    <select
                                      className="h-10 w-full rounded-xl border border-pharma-grey-pale bg-white px-3 text-sm text-pharma-charcoal"
                                      value={entry.close}
                                      onChange={(event) => updateDay(day, { close: event.target.value })}
                                      disabled={pharmacyLoading || entry.closed}
                                    >
                                      <option value="">--</option>
                                      {timeOptions.map((time) => (
                                        <option key={`${day}-close-${time}`} value={time}>{time}</option>
                                      ))}
                                    </select>
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {pharmacyErrors.hours && (
                      <p className="text-xs text-pharma-coral">{pharmacyErrors.hours}</p>
                    )}
                  </section>

                  <div className="space-y-2">
                    <label className="text-sm font-medium text-pharma-charcoal">
                      {language === 'el' ? 'Πρόγραμμα εφημερίας' : 'On-call schedule'}
                    </label>
                    <Textarea
                      value={pharmacyForm.on_call_schedule}
                      onChange={handlePharmacyChange('on_call_schedule')}
                      placeholder={language === 'el' ? 'Προσθέστε λεπτομέρειες εφημερίας' : 'Add on-call details'}
                      className="rounded-xl"
                      rows={3}
                      data-testid="pharmacy-oncall-input"
                      disabled={pharmacyLoading}
                    />
                  </div>

                  <div className="flex items-center justify-between rounded-xl border border-pharma-grey-pale/60 bg-white px-4 py-3">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-pharma-teal" />
                      <div>
                        <p className="text-sm text-pharma-charcoal">
                          {language === 'el' ? 'Σε εφημερία' : 'On duty'}
                        </p>
                        <p className="text-xs text-pharma-slate-grey">
                          {language === 'el' ? 'Εμφάνιση στις εφημερίες' : 'Visible in on-call list'}
                        </p>
                      </div>
                    </div>
                    <Switch
                      checked={pharmacyForm.is_on_call}
                      onCheckedChange={(checked) => handlePharmacyChange('is_on_call')(checked)}
                      data-testid="pharmacy-oncall-toggle"
                      disabled={pharmacyLoading}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 pt-2">
                <Button
                  variant="outline"
                  className="rounded-full flex-1"
                  onClick={handleCancel}
                  disabled={saving || loading || (isPharmacistRole && pharmacyLoading)}
                  data-testid="profile-cancel-btn"
                >
                  {t('cancel')}
                </Button>
                <Button
                  className="rounded-full flex-1 bg-pharma-teal hover:bg-pharma-teal/90"
                  onClick={handleSave}
                  disabled={saving || loading || (isPharmacistRole && pharmacyLoading)}
                  data-testid="profile-save-btn"
                >
                  {saving
                    ? (language === 'el' ? 'Αποθήκευση...' : 'Saving...')
                    : (language === 'el' ? 'Αποθήκευση' : 'Save')}
                </Button>
              </div>
            </CardContent>
          </Card>

          {isPharmacistRole && (
            <Card className="bg-white rounded-xl shadow-card border-pharma-grey-pale/50 mt-4">
              <CardContent className="p-4 flex items-center gap-3">
                <Shield className="w-5 h-5 text-pharma-slate-grey" />
                <p className="text-xs text-pharma-slate-grey">
                  {language === 'el'
                    ? 'Η επαλήθευση φαρμακείου γίνεται από το σύστημα και δεν είναι επεξεργάσιμη.'
                    : 'Verification is system-managed and not editable.'}
                </p>
              </CardContent>
            </Card>
          )}
        </section>
      </main>
    </div>
  );
}
