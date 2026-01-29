import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

// Simplified roles: patient and pharmacist only
export const ROLES = {
  PATIENT: 'patient',
  PHARMACIST: 'pharmacist'
};

// Global loading timeout (10 seconds max)
const LOADING_TIMEOUT_MS = 10000;
const FETCH_TIMEOUT_MS = 8000;
let timeLabelCounter = 0;

const withTimeout = (promise, ms, label) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Timeout after ${ms}ms${label ? ` (${label})` : ''}`);
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
};

const timed = async (label, promise) => {
  const isDev = process.env.NODE_ENV === 'development';
  const uniqueLabel = isDev ? `${label}#${++timeLabelCounter}` : label;
  console.time(uniqueLabel);
  try {
    return await promise;
  } finally {
    console.timeEnd(uniqueLabel);
  }
};

const logStep = (step, details = {}) => {
  console.info(`[auth] ${step}`, details);
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingTimedOut, setLoadingTimedOut] = useState(false);
  const [error, setError] = useState(null);
  const loadingTimeoutRef = useRef(null);
  const initAuthRef = useRef(false);

  // Global loading safeguard - prevents spinner from showing > 10s
  useEffect(() => {
    if (loading && !loadingTimedOut) {
      loadingTimeoutRef.current = setTimeout(() => {
        console.error('AuthContext: Global loading timeout exceeded (10s). Forcing loading=false.');
        setLoading(false);
        setLoadingTimedOut(true);
      }, LOADING_TIMEOUT_MS);
    } else if (!loading && loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }
    return () => {
      if (loadingTimeoutRef.current) {
        clearTimeout(loadingTimeoutRef.current);
      }
    };
  }, [loading, loadingTimedOut]);

  // Fetch user profile - creates if missing using metadata role
  const fetchProfile = useCallback(async (userId, source = 'unknown') => {
    if (!userId) return null;
    logStep('fetchProfile:start', { source });
    try {
      const { data, error } = await timed(
        'auth:fetchProfile:select',
        withTimeout(
          supabase
            .from('profiles')
            .select('*')
            .eq('id', userId)
            .maybeSingle(),
          FETCH_TIMEOUT_MS,
          'profiles.select'
        )
      );

      if (error) {
        logStep('fetchProfile:select:error', { source, code: error.code, status: error.status });
        throw error;
      }

      if (!data) {
        // Profile doesn't exist - this can happen if trigger didn't fire
        // Get current user to read metadata
        const { data: userData, error: userError } = await timed(
          'auth:fetchProfile:getUser',
          withTimeout(supabase.auth.getUser(), FETCH_TIMEOUT_MS, 'auth.getUser')
        );

        if (userError) {
          logStep('fetchProfile:getUser:error', { source, code: userError.code, status: userError.status });
          return null;
        }

        const currentUser = userData?.user;
        const metadataRole = currentUser?.user_metadata?.role;
        const finalRole = (metadataRole === 'pharmacist') ? 'pharmacist' : 'patient';

        logStep('fetchProfile:create', { source, role: finalRole });

        // Create or ensure profile with role from metadata
        const { data: newProfile, error: createError } = await timed(
          'auth:fetchProfile:createProfile',
          withTimeout(
            supabase
              .from('profiles')
              .upsert([{
                id: userId,
                role: finalRole,
                email: currentUser?.email,
                full_name: currentUser?.user_metadata?.full_name || '',
                pharmacy_name: currentUser?.user_metadata?.pharmacy_name || null,
                language: 'el',
                senior_mode: false
              }], { onConflict: 'id' })
              .select()
              .single(),
            FETCH_TIMEOUT_MS,
            'profiles.upsert'
          )
        );

        if (createError) {
          logStep('fetchProfile:create:error', { source, code: createError.code, status: createError.status });
          console.error('fetchProfile: create profile failed', {
            message: createError?.message,
            code: createError?.code,
            status: createError?.status
          });
          return null;
        }

        if (process.env.NODE_ENV === 'development') {
          console.log('[auth] profile ensured via upsert', { userId, source });
        }
        setProfile(newProfile);
        logStep('fetchProfile:success', { source, created: true });
        return newProfile;
      }

      setProfile(data);
      logStep('fetchProfile:success', { source, created: false });
      return data;
    } catch (err) {
      logStep('fetchProfile:error', { source, name: err?.name, message: err?.message });
      return null;
    }
  }, []);

  // Create user profile - stores role exactly as provided (patient or pharmacist)
  const createProfile = useCallback(async (userId, role, additionalData = {}) => {
    try {
      // Normalize role: only 'patient' or 'pharmacist' allowed
      const normalizedRole = role === 'pharmacist' ? ROLES.PHARMACIST : ROLES.PATIENT;
      
      const profileData = {
        id: userId,
        role: normalizedRole,
        language: 'el',
        senior_mode: false,
        created_at: new Date().toISOString(),
        ...additionalData
      };

      const { data, error } = await timed(
        'auth:createProfile',
        withTimeout(
          supabase
            .from('profiles')
            .insert([profileData])
            .select()
            .single(),
          FETCH_TIMEOUT_MS,
          'profiles.insert'
        )
      );

      if (error) {
        throw error;
      }
      
      setProfile(data);
      return data;
    } catch (err) {
      console.error('createProfile failed (profiles.insert):', {
        message: err?.message,
        code: err?.code,
        status: err?.status
      });
      throw err;
    }
  }, []);

  // Sign up (OTP flow: do NOT create profile here)
  const signUp = useCallback(async (email, password, role, additionalData = {}) => {
    try {
      setError(null);
      // Normalize role for metadata
      const normalizedRole = role === 'pharmacist' ? ROLES.PHARMACIST : ROLES.PATIENT;

      const { data, error } = await timed(
        'auth:signUp',
        withTimeout(
          supabase.auth.signUp({
            email,
            password,
            options: {
              data: {
                role: normalizedRole
              }
            }
          }),
          FETCH_TIMEOUT_MS,
          'auth.signUp'
        )
      );

      if (error) throw error;

      // IMPORTANT: No createProfile here (OTP confirmation required first)
      return { data, error: null };
    } catch (err) {
      setError(err?.message || 'Sign up failed');
      return { data: null, error: err };
    }
  }, []);

  // Sign in
  const signIn = useCallback(async (email, password) => {
    try {
      setError(null);
      
      const { data, error } = await timed(
        'auth:signIn',
        withTimeout(
          supabase.auth.signInWithPassword({
            email,
            password
          }),
          FETCH_TIMEOUT_MS,
          'auth.signInWithPassword'
        )
      );

      if (error) throw error;

      if (data.user) {
        await fetchProfile(data.user.id, 'signIn');
      }

      return { data, error: null };
    } catch (err) {
      setError(err.message);
      return { data: null, error: err };
    }
  }, [fetchProfile]);

  // Sign out
  const signOut = useCallback(async () => {
    try {
      const { error } = await timed(
        'auth:signOut',
        withTimeout(supabase.auth.signOut(), FETCH_TIMEOUT_MS, 'auth.signOut')
      );
      if (error) throw error;
      
      setUser(null);
      setSession(null);
      setProfile(null);
      
      return { error: null };
    } catch (err) {
      setError(err.message);
      return { error: err };
    }
  }, []);

  // Update profile
  const updateProfile = useCallback(async (updates) => {
    if (!user) return { error: new Error('Not authenticated') };

    try {
      const { data, error } = await timed(
        'auth:updateProfile',
        withTimeout(
          supabase
            .from('profiles')
            .update(updates)
            .eq('id', user.id)
            .select()
            .single(),
          FETCH_TIMEOUT_MS,
          'profiles.update'
        )
      );

      if (error) throw error;
      
      setProfile(data);
      return { data, error: null };
    } catch (err) {
      console.error('updateProfile failed (profiles.update):', {
        message: err?.message,
        code: err?.code,
        status: err?.status
      });
      return { data: null, error: err };
    }
  }, [user]);

  // Check if user is verified pharmacist (for backward compat - now just checks pharmacist)
  const isVerifiedPharmacist = useCallback(() => {
    return profile?.role === ROLES.PHARMACIST;
  }, [profile]);

  // Check if user is pending pharmacist (deprecated - returns false now)
  const isPendingPharmacist = useCallback(() => {
    return false; // No more pending state
  }, []);

  // Check if user is patient
  const isPatient = useCallback(() => {
    return profile?.role === ROLES.PATIENT;
  }, [profile]);

  // Check if user is any type of pharmacist
  const isPharmacist = useCallback(() => {
    return profile?.role === ROLES.PHARMACIST;
  }, [profile]);

  // Centralized role resolver - single source of truth
  const getRole = useCallback(() => {
    return profile?.role || null;
  }, [profile]);

  // Initialize auth state
  useEffect(() => {
    if (initAuthRef.current) return;
    initAuthRef.current = true;
    const initAuth = async () => {
      logStep('init:start');
      try {
        const { data, error } = await timed(
          'auth:init:getSession',
          withTimeout(supabase.auth.getSession(), FETCH_TIMEOUT_MS, 'auth.getSession')
        );

        if (error) {
          logStep('init:getSession:error', { code: error.code, status: error.status });
        }

        const nextSession = data?.session || null;
        setSession(nextSession);

        if (nextSession?.user) {
          setUser(nextSession.user);
          logStep('init:session', { hasUser: true });
          // Do not block global loading on profile fetch
          void fetchProfile(nextSession.user.id, 'init');
        } else {
          setUser(null);
          setProfile(null);
          logStep('init:session', { hasUser: false });
        }
      } catch (err) {
        logStep('init:error', { name: err?.name, message: err?.message });
      } finally {
        setLoading(false);
        logStep('init:end', { loading: false });
      }
    };

    initAuth();
  }, [fetchProfile]);

  // Listen for auth changes
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      logStep('authStateChange', { event, hasSession: !!session, hasUser: !!session?.user });
      setSession(session || null);
      if (event === 'SIGNED_IN' && session?.user) {
        setUser(session.user);
        void fetchProfile(session.user.id, 'authStateChange');
      } else if (event === 'SIGNED_OUT') {
        setUser(null);
        setProfile(null);
      }
    });

    return () => {
      subscription?.unsubscribe();
    };
  }, [fetchProfile]);

  const value = {
    user,
    session,
    profile,
    loading,
    loadingTimedOut,
    error,
    signUp,
    signIn,
    signOut,
    updateProfile,
    createProfile,
    fetchProfile,
    isVerifiedPharmacist,
    isPendingPharmacist,
    isPatient,
    isPharmacist,
    getRole,
    ROLES
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
