// Backend Server for ESPN Fantasy Football Dual League Dashboard
require('dotenv').config();
const express = require('express');
const { Client } = require('espn-fantasy-football-api/node');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Load team ownership data
const teamsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'teams.json'), 'utf8'));

// League Configurations
const LEAGUES = {
  green: {
    leagueId: parseInt(process.env.GREEN_LEAGUE_ID),
    seasonId: parseInt(process.env.SEASON_ID) || 2025,
    espnS2: process.env.G_ESPN_S2,
    swid: process.env.G_SWID
  },
  white: {
    leagueId: parseInt(process.env.WHITE_LEAGUE_ID),
    seasonId: parseInt(process.env.SEASON_ID) || 2025,
    espnS2: process.env.W_ESPN_S2,
    swid: process.env.W_SWID
  }
};

// Initialize clients
const greenClient = new Client({ leagueId: LEAGUES.green.leagueId });
const whiteClient = new Client({ leagueId: LEAGUES.white.leagueId });

if (LEAGUES.green.espnS2 && LEAGUES.green.swid) {
  greenClient.setCookies({ espnS2: LEAGUES.green.espnS2, SWID: LEAGUES.green.swid });
}

if (LEAGUES.white.espnS2 && LEAGUES.white.swid) {
  whiteClient.setCookies({ espnS2: LEAGUES.white.espnS2, SWID: LEAGUES.white.swid });
}

// Helper function to get league data
async function getLeagueData(client, seasonId) {
  const leagueInfo = await client.getLeagueInfo({ seasonId });
  const teams = await client.getTeamsAtWeek({
    seasonId,
    scoringPeriodId: leagueInfo.currentScoringPeriodId
  });

  const division = client === greenClient ? 'green' : 'white';

  const standings = teams.map(team => {
    const ownerInfo = teamsData[division]?.[team.id.toString()];

    return {
      id: team.id,
      name: team.name,
      owner: ownerInfo?.owner || '',
      championships: ownerInfo?.wins?.filter(year => year !== '') || [],
      wins: team.wins,
      losses: team.losses,
      ties: team.ties,
      points: team.totalPointsScored,
      pointsAgainst: team.regularSeasonPointsAgainst
    };
  }).sort((a, b) => {
    if (b.wins !== a.wins) return b.wins - a.wins;
    return b.points - a.points;
  });

  return {
    name: leagueInfo.name,
    currentWeek: leagueInfo.currentMatchupPeriodId,
    standings
  };
}

// Helper function to get matchups
async function getMatchups(client, seasonId, week) {
  const [scoreboard, teams] = await Promise.all([
    client.getBoxscoreForWeek({
      seasonId,
      matchupPeriodId: week,
      scoringPeriodId: week
    }),
    client.getTeamsAtWeek({
      seasonId,
      scoringPeriodId: week
    })
  ]);

  const teamMap = {};
  teams.forEach(team => {
    teamMap[team.id] = {
      name: team.name,
      id: team.id
    };
  });

  return scoreboard.map(matchup => ({
    homeTeam: teamMap[matchup.homeTeamId]?.name || 'Unknown',
    homeTeamId: matchup.homeTeamId,
    homeScore: matchup.homeScore,
    awayTeam: teamMap[matchup.awayTeamId]?.name || 'Unknown',
    awayTeamId: matchup.awayTeamId,
    awayScore: matchup.awayScore
  }));
}

app.get('/api/summary', async (req, res) => {
  try {
    const [greenData, whiteData] = await Promise.all([
      getLeagueData(greenClient, LEAGUES.green.seasonId),
      getLeagueData(whiteClient, LEAGUES.white.seasonId)
    ]);

    const [greenMatchups, whiteMatchups] = await Promise.all([
      getMatchups(greenClient, LEAGUES.green.seasonId, greenData.currentWeek),
      getMatchups(whiteClient, LEAGUES.white.seasonId, whiteData.currentWeek)
    ]);

    res.json({
      green: { ...greenData, matchups: greenMatchups },
      white: { ...whiteData, matchups: whiteMatchups }
    });
  } catch (error) {
    console.error('Error fetching summary:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/league/:division', async (req, res) => {
  try {
    const division = req.params.division;
    if (!['green', 'white'].includes(division)) {
      return res.status(400).json({ error: 'Invalid division' });
    }

    const client = division === 'green' ? greenClient : whiteClient;
    const config = LEAGUES[division];
    const data = await getLeagueData(client, config.seasonId);
    const matchups = await getMatchups(client, config.seasonId, data.currentWeek);

    res.json({ ...data, matchups });
  } catch (error) {
    console.error(`Error fetching ${req.params.division} league:`, error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/roster/:division/:teamId', async (req, res) => {
  try {
    const { division, teamId } = req.params;
    if (!['green', 'white'].includes(division)) {
      return res.status(400).json({ error: 'Invalid division' });
    }

    const client = division === 'green' ? greenClient : whiteClient;
    const config = LEAGUES[division];
    const leagueInfo = await client.getLeagueInfo({ seasonId: config.seasonId });

    const [boxscores, teams] = await Promise.all([
      client.getBoxscoreForWeek({
        seasonId: config.seasonId,
        matchupPeriodId: leagueInfo.currentMatchupPeriodId,
        scoringPeriodId: leagueInfo.currentScoringPeriodId
      }),
      client.getTeamsAtWeek({
        seasonId: config.seasonId,
        scoringPeriodId: leagueInfo.currentScoringPeriodId
      })
    ]);

    const teamBoxscore = boxscores.find(box =>
      box.homeTeamId === parseInt(teamId) || box.awayTeamId === parseInt(teamId)
    );

    if (!teamBoxscore) {
      return res.status(404).json({ error: 'Team not found' });
    }

    const team = teams.find(t => t.id === parseInt(teamId));
    const ownerInfo = teamsData[division]?.[teamId.toString()];
    const isHome = teamBoxscore.homeTeamId === parseInt(teamId);
    const roster = isHome ? teamBoxscore.homeRoster : teamBoxscore.awayRoster;

    const positionOrder = {
      'QB': 1, 'RB': 2, 'WR': 3, 'TE': 4, 'FLEX': 5, 'RB/WR/TE': 5,
      'D/ST': 6, 'K': 7, 'Bench': 99, 'IR': 100
    };

    const formattedRoster = roster.map(player => ({
      name: player.fullName,
      position: player.defaultPosition,
      proTeam: player.proTeamAbbreviation,
      isStarter: player.rosteredPosition !== 'Bench' && player.rosteredPosition !== 'IR',
      slotPosition: player.rosteredPosition
    })).sort((a, b) => {
      if (a.isStarter && !b.isStarter) return -1;
      if (!a.isStarter && b.isStarter) return 1;
      return (positionOrder[a.slotPosition] || 99) - (positionOrder[b.slotPosition] || 99);
    });

    res.json({
      teamId: parseInt(teamId),
      teamName: team?.name || 'Unknown',
      owner: ownerInfo?.owner || '',
      championships: ownerInfo?.wins?.filter(year => year !== '') || [],
      roster: formattedRoster
    });
  } catch (error) {
    console.error('Error fetching roster:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/matchup/:division/:homeTeamId/:awayTeamId', async (req, res) => {
  try {
    const { division, homeTeamId, awayTeamId } = req.params;
    if (!['green', 'white'].includes(division)) {
      return res.status(400).json({ error: 'Invalid division' });
    }

    const client = division === 'green' ? greenClient : whiteClient;
    const config = LEAGUES[division];
    const leagueInfo = await client.getLeagueInfo({ seasonId: config.seasonId });

    const [boxscores, teams] = await Promise.all([
      client.getBoxscoreForWeek({
        seasonId: config.seasonId,
        matchupPeriodId: leagueInfo.currentMatchupPeriodId,
        scoringPeriodId: leagueInfo.currentScoringPeriodId
      }),
      client.getTeamsAtWeek({
        seasonId: config.seasonId,
        scoringPeriodId: leagueInfo.currentScoringPeriodId
      })
    ]);

    const matchup = boxscores.find(box =>
      (box.homeTeamId === parseInt(homeTeamId) && box.awayTeamId === parseInt(awayTeamId)) ||
      (box.homeTeamId === parseInt(awayTeamId) && box.awayTeamId === parseInt(homeTeamId))
    );

    if (!matchup) {
      return res.status(404).json({ error: 'Matchup not found' });
    }

    const homeTeam = teams.find(t => t.id === matchup.homeTeamId);
    const awayTeam = teams.find(t => t.id === matchup.awayTeamId);
    const homeOwner = teamsData[division]?.[matchup.homeTeamId.toString()]?.owner || '';
    const awayOwner = teamsData[division]?.[matchup.awayTeamId.toString()]?.owner || '';
    const homeChampionships = teamsData[division]?.[matchup.homeTeamId.toString()]?.wins?.filter(year => year !== '') || [];
    const awayChampionships = teamsData[division]?.[matchup.awayTeamId.toString()]?.wins?.filter(year => year !== '') || [];

    const positionOrder = {
      'QB': 1, 'RB': 2, 'WR': 3, 'TE': 4, 'FLEX': 5, 'RB/WR/TE': 5,
      'D/ST': 6, 'K': 7, 'Bench': 99, 'IR': 100
    };

    const formatRoster = (roster) => {
      return roster
        .filter(player => player.rosteredPosition !== 'Bench' && player.rosteredPosition !== 'IR')
        .map(player => ({
          name: player.fullName,
          position: player.rosteredPosition,
          points: player.totalPoints || 0,
          projected: player.projectedPointBreakdown ?
            Object.values(player.projectedPointBreakdown).reduce((a, b) => a + b, 0) : 0
        }))
        .sort((a, b) => (positionOrder[a.position] || 99) - (positionOrder[b.position] || 99));
    };

    res.json({
      homeTeam: homeTeam?.name || 'Unknown',
      homeOwner: homeOwner,
      homeScore: matchup.homeScore,
      homeRoster: formatRoster(matchup.homeRoster),
      homeChampionships: homeChampionships,
      awayTeam: awayTeam?.name || 'Unknown',
      awayOwner: awayOwner,
      awayScore: matchup.awayScore,
      awayChampionships: awayChampionships,
      awayRoster: formatRoster(matchup.awayRoster)
    });
  } catch (error) {
    console.error('Error fetching matchup details:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// SSL Certificate paths
const HTTP_PORT = process.env.HTTP_PORT || 80;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;

const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/www.hoganfantasy.com/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/www.hoganfantasy.com/fullchain.pem')
};

// Create HTTP server (redirects to HTTPS)
http.createServer((req, res) => {
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
}).listen(HTTP_PORT, () => {
  console.log(`HTTP server running on port ${HTTP_PORT} (redirecting to HTTPS)`);
});

// Create HTTPS server
https.createServer(sslOptions, app).listen(HTTPS_PORT, () => {
  console.log(`\nFantasy Football Dashboard running on port ${HTTPS_PORT} (HTTPS)`);
  console.log(`API Endpoints:`);
  console.log(`  GET /api/summary - Get both leagues data`);
  console.log(`  GET /api/league/green - Get green division only`);
  console.log(`  GET /api/league/white - Get white division only`);
  console.log(`  GET /api/roster/:division/:teamId - Get team roster`);
  console.log(`  GET /api/matchup/:division/:homeTeamId/:awayTeamId - Get matchup details`);
  console.log(`  GET /api/health - Health check`);
  console.log(`\nFrontend available at https://www.hoganfantasy.com`);
});
