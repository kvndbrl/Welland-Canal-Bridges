async function sendNotifications(bridge, status, bridgeData = {}) {
  if (status !== 'disponible') disponibleSince[bridge] = null;
  const statuses = Object.fromEntries(BRIDGE_IDS.map(id => {
    const last = liftHistory[id]?.[liftHistory[id].length - 1];
    return [id, {
      status: lastStatus[id] || 'disponible',
      avgMin: getAvgLiftMin(id),
      liftingSince: (last && last.raisedAt && !last.loweredAt) ? new Date(last.raisedAt).getTime() : null,
    }];
  }));
  const lastEntry = liftHistory[bridge]?.[liftHistory[bridge].length - 1];
  statuses[bridge] = {
    status,
    avgMin: bridgeData.avgMin || getAvgLiftMin(bridge),
    liftingSince: (lastEntry && lastEntry.raisedAt && !lastEntry.loweredAt) ? new Date(lastEntry.raisedAt).getTime() : null,
  };
  await sendWellandWidgetUpdate(statuses);
  log(`Widget notification [${bridge}] ${status}`);
}

