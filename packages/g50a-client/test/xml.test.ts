import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPacket, collectErrors, isErrorResponse, parsePacket } from '../src/xml.js';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8');

describe('parsePacket', () => {
  it('parses a MnetGroupList getResponse', () => {
    const packet = parsePacket(fixture('group-list.xml'));
    expect(packet.Packet.Command).toBe('getResponse');
    const records =
      packet.Packet.DatabaseManager?.ControlGroup?.MnetGroupList?.MnetGroupRecord ?? [];
    expect(records).toHaveLength(5);
    expect(records[0]).toMatchObject({ Group: '1', Model: 'IC', Address: '1' });
  });

  it('parses a multi-group bulk poll response', () => {
    const packet = parsePacket(fixture('bulk-poll-5.xml'));
    const elements = packet.Packet.DatabaseManager?.Mnet ?? [];
    expect(elements).toHaveLength(5);
    expect(elements[0]?.Group).toBe('1');
    expect(elements[0]?.Bulk?.startsWith('010001')).toBe(true);
  });

  it('parses SystemData', () => {
    const packet = parsePacket(fixture('system-data.xml'));
    const sd = packet.Packet.DatabaseManager?.SystemData as Record<string, string>;
    expect(sd.Model).toBeDefined();
    expect(sd.Version).toBeDefined();
    expect(sd.TempUnit).toBe('C');
    expect(sd.MacAddress).toMatch(/^[0-9A-F]{12}$/);
  });

  it('parses a setResponse', () => {
    const packet = parsePacket(fixture('set-response.xml'));
    expect(packet.Packet.Command).toBe('setResponse');
    expect(packet.Packet.DatabaseManager?.Mnet?.[0]).toMatchObject({
      Group: '5',
      Drive: 'OFF',
    });
  });
});

describe('collectErrors / isErrorResponse', () => {
  it('finds the Unknown Object error in a getErrorResponse', () => {
    const packet = parsePacket(fixture('get-error-response.xml'));
    expect(isErrorResponse(packet.Packet.Command)).toBe(true);
    const errors = collectErrors(packet);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      point: 'ConnectionInfo',
      code: '0001',
      message: 'Unknown Object',
    });
  });

  it('finds the Invalid Value error in a setErrorResponse', () => {
    const packet = parsePacket(fixture('set-error-response.xml'));
    expect(isErrorResponse(packet.Packet.Command)).toBe(true);
    const errors = collectErrors(packet);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]?.code).toBe('0201');
    expect(errors[0]?.message).toBe('Invalid Value');
    expect(errors[0]?.point).toContain('GroupNameWeb');
  });

  it('returns an empty array for a non-error response', () => {
    const packet = parsePacket(fixture('group-list.xml'));
    expect(isErrorResponse(packet.Packet.Command)).toBe(false);
    expect(collectErrors(packet)).toEqual([]);
  });
});

describe('buildPacket', () => {
  it('builds a getRequest for MnetGroupList', () => {
    const xml = buildPacket({
      Command: 'getRequest',
      DatabaseManager: { ControlGroup: { MnetGroupList: {} } },
    });
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<Command>getRequest</Command>');
    expect(xml).toContain('<MnetGroupList');
    expect(xml).toContain('</Packet>');
  });

  it('builds a multi-attribute setRequest Mnet element', () => {
    const xml = buildPacket({
      Command: 'setRequest',
      DatabaseManager: {
        Mnet: [{ Group: '3', Drive: 'ON', Mode: 'HEAT', SetTemp: '25.0' }],
      },
    });
    expect(xml).toContain('<Mnet Group="3" Drive="ON" Mode="HEAT" SetTemp="25.0"');
  });
});
