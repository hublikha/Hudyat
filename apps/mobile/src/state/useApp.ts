import type { Invitation, PendingVerification } from '@rcn/core';
import {
  Db,
  DeviceRow,
  MessageRow,
  currentFamily,
  latestSafetyPerDevice,
  listMessages,
  listTrustedDevices,
} from '@rcn/core';
import { DeviceId } from '@rcn/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { openDatabase } from '../db/expoDb';
import { Engine, PeerView } from '../engine/engine';
import { SelfIdentity, loadOrCreateIdentity } from '../engine/identity';

/**
 * Application state.
 *
 * Reads come straight from SQLite rather than a mirrored in-memory copy. A
 * cache that drifts from the database would show a message as delivered when
 * the durable record says otherwise, and the durable record is the one that
 * survives a restart — so it is the one the user is shown.
 */

export type Startup =
  | { phase: 'LOADING' }
  | { phase: 'READY' }
  | { phase: 'FAILED'; error: string };

export interface PairingReady {
  pending: PendingVerification;
  invitation: Invitation;
}

export interface AppState {
  startup: Startup;
  db: Db | null;
  engine: Engine | null;
  self: SelfIdentity | null;
  family: { family_id: string; name: string } | null;
  peers: PeerView[];
  transport: string;
  errors: string[];
  pairingReady: PairingReady | null;
  pairingError: string | null;
  clearPairing: () => void;
  refresh: () => void;
  version: number;
}

export function useApp(): AppState {
  const [startup, setStartup] = useState<Startup>({ phase: 'LOADING' });
  const [self, setSelf] = useState<SelfIdentity | null>(null);
  const [family, setFamily] = useState<{ family_id: string; name: string } | null>(null);
  const [peers, setPeers] = useState<PeerView[]>([]);
  const [transport, setTransport] = useState('STOPPED');
  const [errors, setErrors] = useState<string[]>([]);
  const [pairingReady, setPairingReady] = useState<PairingReady | null>(null);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const dbRef = useRef<Db | null>(null);
  const engineRef = useRef<Engine | null>(null);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const clearPairing = useCallback(() => {
    setPairingReady(null);
    setPairingError(null);
    engineRef.current?.cancelPairing();
  }, []);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const db = openDatabase();
        dbRef.current = db;

        const identity = await loadOrCreateIdentity(db);
        if (cancelled) return;
        setSelf(identity);
        setFamily(currentFamily(db) ?? null);

        const engine = new Engine(db);
        engineRef.current = engine;
        engine.subscribe((event) => {
          if (event.type === 'peers') setPeers(event.peers);
          else if (event.type === 'transport') setTransport(event.state);
          else if (event.type === 'changed') refresh();
          else if (event.type === 'pairing-ready') {
            setPairingReady({ pending: event.pending, invitation: event.invitation });
            setPairingError(null);
          } else if (event.type === 'pairing-failed') {
            setPairingReady(null);
            setPairingError(event.message);
          } else if (event.type === 'error') {
            // Kept and shown rather than logged and lost. A message that was
            // rejected is something the user needs to be able to see.
            setErrors((prev) => [event.message, ...prev].slice(0, 20));
          }
        });

        setStartup({ phase: 'READY' });
      } catch (error) {
        if (cancelled) return;
        // Startup failure is shown, not swallowed. A release build that dies
        // silently here is exactly what Phase 0 spent an evening diagnosing.
        setStartup({ phase: 'FAILED', error: (error as Error).message });
      }
    })();

    return () => {
      cancelled = true;
      void engineRef.current?.stop();
    };
  }, [refresh]);

  return useMemo(
    () => ({
      startup,
      db: dbRef.current,
      engine: engineRef.current,
      self,
      family,
      peers,
      transport,
      errors,
      pairingReady,
      pairingError,
      clearPairing,
      refresh,
      version,
    }),
    [
      startup,
      self,
      family,
      peers,
      transport,
      errors,
      pairingReady,
      pairingError,
      clearPairing,
      refresh,
      version,
    ],
  );
}

export function useTrustedDevices(db: Db | null, familyId: string | null, version: number) {
  return useMemo(() => {
    if (!db || !familyId) return [];
    return listTrustedDevices(db, familyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, familyId, version]);
}

export function useMessages(db: Db | null, conversationId: string | null, version: number) {
  return useMemo<MessageRow[]>(() => {
    if (!db || !conversationId) return [];
    return listMessages(db, conversationId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, conversationId, version]);
}

export function useSafety(db: Db | null, familyId: string | null, version: number) {
  return useMemo(() => {
    if (!db || !familyId) return [];
    return latestSafetyPerDevice(db, familyId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, familyId, version]);
}

export function conversationIdFor(a: DeviceId, b: DeviceId): string {
  // Sorted so both devices name the same conversation without negotiating.
  return `c-${[a, b].sort().join('-')}`;
}

export type { DeviceRow };
