/**
 * declination.js
 * -----------------------------------------------------------------------
 * Cálculo da declinação magnética (diferença entre o Norte magnético, lido
 * pela bússola do aparelho, e o Norte verdadeiro/geográfico, usado pelas
 * coordenadas GPS e pelos mapas) usando o World Magnetic Model 2025
 * (WMM2025), o modelo oficial da NOAA/NGA e do Reino Unido (Defence
 * Geographic Centre), válido para 2025.0–2030.0.
 *
 * POR QUE ISSO É NECESSÁRIO: a bússola do celular (compass.js) lê o campo
 * magnético da Terra diretamente — ela aponta para o Norte MAGNÉTICO, não
 * para o Norte VERDADEIRO usado pelos mapas e coordenadas. A diferença
 * entre os dois (a "declinação magnética") varia bastante conforme a
 * localização — no Brasil, por exemplo, gira em torno de 15 a 24° a Oeste
 * em boa parte do território — e, sem essa correção, o mapa girado pela
 * bússola fica sistematicamente deslocado em relação à realidade.
 *
 * Coeficientes de Gauss (g, h) e suas variações anuais (g_dot, h_dot) até
 * grau/ordem 12, exatamente como publicados no arquivo oficial WMM.COF:
 * https://www.ncei.noaa.gov/products/world-magnetic-model (epoch 2025.0,
 * lançado em 11/13/2024).
 *
 * O algoritmo (expansão em harmônicos esféricos + funções de Legendre
 * associadas semi-normalizadas de Schmidt) segue o método de referência
 * publicado pela NOAA/NGA para o WMM — a mesma técnica usada por todo
 * receptor de GPS e app de navegação profissional para essa correção.
 */

(function () {
  const WMM_EPOCH = 2025.0;
  const WMM_VALID_ATE = 2030.0;

  // Tabela de coeficientes WMM2025: [n, m, gnm, hnm, dgnm/ano, dhnm/ano]
  const COEFICIENTES = [
    [1, 0, -29351.8, 0.0, 12.0, 0.0],
    [1, 1, -1410.8, 4545.4, 9.7, -21.5],
    [2, 0, -2556.6, 0.0, -11.6, 0.0],
    [2, 1, 2951.1, -3133.6, -5.2, -27.7],
    [2, 2, 1649.3, -815.1, -8.0, -12.1],
    [3, 0, 1361.0, 0.0, -1.3, 0.0],
    [3, 1, -2404.1, -56.6, -4.2, 4.0],
    [3, 2, 1243.8, 237.5, 0.4, -0.3],
    [3, 3, 453.6, -549.5, -15.6, -4.1],
    [4, 0, 895.0, 0.0, -1.6, 0.0],
    [4, 1, 799.5, 278.6, -2.4, -1.1],
    [4, 2, 55.7, -133.9, -6.0, 4.1],
    [4, 3, -281.1, 212.0, 5.6, 1.6],
    [4, 4, 12.1, -375.6, -7.0, -4.4],
    [5, 0, -233.2, 0.0, 0.6, 0.0],
    [5, 1, 368.9, 45.4, 1.4, -0.5],
    [5, 2, 187.2, 220.2, 0.0, 2.2],
    [5, 3, -138.7, -122.9, 0.6, 0.4],
    [5, 4, -142.0, 43.0, 2.2, 1.7],
    [5, 5, 20.9, 106.1, 0.9, 1.9],
    [6, 0, 64.4, 0.0, -0.2, 0.0],
    [6, 1, 63.8, -18.4, -0.4, 0.3],
    [6, 2, 76.9, 16.8, 0.9, -1.6],
    [6, 3, -115.7, 48.8, 1.2, -0.4],
    [6, 4, -40.9, -59.8, -0.9, 0.9],
    [6, 5, 14.9, 10.9, 0.3, 0.7],
    [6, 6, -60.7, 72.7, 0.9, 0.9],
    [7, 0, 79.5, 0.0, -0.0, 0.0],
    [7, 1, -77.0, -48.9, -0.1, 0.6],
    [7, 2, -8.8, -14.4, -0.1, 0.5],
    [7, 3, 59.3, -1.0, 0.5, -0.8],
    [7, 4, 15.8, 23.4, -0.1, 0.0],
    [7, 5, 2.5, -7.4, -0.8, -1.0],
    [7, 6, -11.1, -25.1, -0.8, 0.6],
    [7, 7, 14.2, -2.3, 0.8, -0.2],
    [8, 0, 23.2, 0.0, -0.1, 0.0],
    [8, 1, 10.8, 7.1, 0.2, -0.2],
    [8, 2, -17.5, -12.6, 0.0, 0.5],
    [8, 3, 2.0, 11.4, 0.5, -0.4],
    [8, 4, -21.7, -9.7, -0.1, 0.4],
    [8, 5, 16.9, 12.7, 0.3, -0.5],
    [8, 6, 15.0, 0.7, 0.2, -0.6],
    [8, 7, -16.8, -5.2, -0.0, 0.3],
    [8, 8, 0.9, 3.9, 0.2, 0.2],
    [9, 0, 4.6, 0.0, -0.0, 0.0],
    [9, 1, 7.8, -24.8, -0.1, -0.3],
    [9, 2, 3.0, 12.2, 0.1, 0.3],
    [9, 3, -0.2, 8.3, 0.3, -0.3],
    [9, 4, -2.5, -3.3, -0.3, 0.3],
    [9, 5, -13.1, -5.2, 0.0, 0.2],
    [9, 6, 2.4, 7.2, 0.3, -0.1],
    [9, 7, 8.6, -0.6, -0.1, -0.2],
    [9, 8, -8.7, 0.8, 0.1, 0.4],
    [9, 9, -12.9, 10.0, -0.1, 0.1],
    [10, 0, -1.3, 0.0, 0.1, 0.0],
    [10, 1, -6.4, 3.3, 0.0, 0.0],
    [10, 2, 0.2, 0.0, 0.1, -0.0],
    [10, 3, 2.0, 2.4, 0.1, -0.2],
    [10, 4, -1.0, 5.3, -0.0, 0.1],
    [10, 5, -0.6, -9.1, -0.3, -0.1],
    [10, 6, -0.9, 0.4, 0.0, 0.1],
    [10, 7, 1.5, -4.2, -0.1, 0.0],
    [10, 8, 0.9, -3.8, -0.1, -0.1],
    [10, 9, -2.7, 0.9, -0.0, 0.2],
    [10, 10, -3.9, -9.1, -0.0, -0.0],
    [11, 0, 2.9, 0.0, 0.0, 0.0],
    [11, 1, -1.5, 0.0, -0.0, -0.0],
    [11, 2, -2.5, 2.9, 0.0, 0.1],
    [11, 3, 2.4, -0.6, 0.0, -0.0],
    [11, 4, -0.6, 0.2, 0.0, 0.1],
    [11, 5, -0.1, 0.5, -0.1, -0.0],
    [11, 6, -0.6, -0.3, 0.0, -0.0],
    [11, 7, -0.1, -1.2, -0.0, 0.1],
    [11, 8, 1.1, -1.7, -0.1, -0.0],
    [11, 9, -1.0, -2.9, -0.1, 0.0],
    [11, 10, -0.2, -1.8, -0.1, 0.0],
    [11, 11, 2.6, -2.3, -0.1, 0.0],
    [12, 0, -2.0, 0.0, 0.0, 0.0],
    [12, 1, -0.2, -1.3, 0.0, -0.0],
    [12, 2, 0.3, 0.7, -0.0, 0.0],
    [12, 3, 1.2, 1.0, -0.0, -0.1],
    [12, 4, -1.3, -1.4, -0.0, 0.1],
    [12, 5, 0.6, -0.0, -0.0, -0.0],
    [12, 6, 0.6, 0.6, 0.1, -0.0],
    [12, 7, 0.5, -0.1, -0.0, -0.0],
    [12, 8, -0.1, 0.8, 0.0, 0.0],
    [12, 9, -0.4, 0.1, 0.0, -0.0],
    [12, 10, -0.2, -1.0, -0.1, -0.0],
    [12, 11, -1.3, 0.1, -0.0, 0.0],
    [12, 12, -0.7, 0.2, -0.1, -0.1],
  ];

  const MAXORD = 12;
  const A_WGS84 = 6378.137; // raio equatorial WGS84 (km)
  const B_WGS84 = 6356.7523142; // raio polar WGS84 (km)
  const RE = 6371.2; // raio médio de referência do WMM (km)

  function novaMatriz() {
    const m = [];
    for (let i = 0; i <= MAXORD; i++) m.push(new Array(MAXORD + 1).fill(0));
    return m;
  }

  // Monta as matrizes de coeficientes de Gauss (g em c[m][n], h em c[n][m-1]) a partir da tabela.
  const c = novaMatriz();
  const cd = novaMatriz();
  COEFICIENTES.forEach(([n, m, gnm, hnm, dgnm, dhnm]) => {
    c[m][n] = gnm;
    cd[m][n] = dgnm;
    if (m !== 0) {
      c[n][m - 1] = hnm;
      cd[n][m - 1] = dhnm;
    }
  });

  // Converte os coeficientes de Gauss (normalizados de Schmidt, como publicados)
  // para a forma usada diretamente na recursão de Legendre abaixo.
  const k = novaMatriz();
  (function normalizarSchmidt() {
    const snorm = novaMatriz();
    snorm[0][0] = 1;
    for (let n = 1; n <= MAXORD; n++) {
      snorm[0][n] = (snorm[0][n - 1] * (2 * n - 1)) / n;
      let j = 2;
      for (let m = 0, d = n - m + 1; d > 0; d--, m++) {
        k[m][n] = ((n - 1) * (n - 1) - m * m) / ((2 * n - 1) * (2 * n - 3));
        if (m > 0) {
          const flnmj = ((n - m + 1) * j) / (n + m);
          snorm[m][n] = snorm[m - 1][n] * Math.sqrt(flnmj);
          j = 1;
          c[n][m - 1] = snorm[m][n] * c[n][m - 1];
          cd[n][m - 1] = snorm[m][n] * cd[n][m - 1];
        }
        c[m][n] = snorm[m][n] * c[m][n];
        cd[m][n] = snorm[m][n] * cd[m][n];
      }
    }
    k[1][1] = 0.0;
  })();

  const fn = [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const fm = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

  function deg2rad(d) {
    return (d * Math.PI) / 180;
  }
  function rad2deg(r) {
    return (r * 180) / Math.PI;
  }

  function anoDecimal(date) {
    const ano = date.getFullYear();
    const bissexto = ano % 400 === 0 || (ano % 4 === 0 && ano % 100 > 0);
    const msNoAno = (365 + (bissexto ? 1 : 0)) * 24 * 60 * 60 * 1000;
    return ano + (date.valueOf() - new Date(ano, 0).valueOf()) / msNoAno;
  }

  /**
   * Calcula a declinação magnética numa coordenada e data.
   * @param {number} lat Latitude em graus (WGS84).
   * @param {number} lon Longitude em graus (WGS84).
   * @param {number} altKm Altitude em km acima do elipsoide WGS84 (padrão 0).
   * @param {Date} date Data para o cálculo (padrão: agora).
   * @returns {number} Declinação em graus. Positivo = Norte magnético a
   *   Leste do Norte verdadeiro; negativo = a Oeste (o caso mais comum no
   *   Brasil). Para corrigir uma leitura de bússola: rumoVerdadeiro =
   *   rumoMagnético + declinação.
   */
  function getDeclination(lat, lon, altKm, date) {
    altKm = altKm || 0;
    date = date || new Date();
    const dt = anoDecimal(date) - WMM_EPOCH;

    const rlat = deg2rad(lat);
    const rlon = deg2rad(lon);
    const srlon = Math.sin(rlon);
    const crlon = Math.cos(rlon);
    const srlat = Math.sin(rlat);
    const crlat = Math.cos(rlat);
    const srlat2 = srlat * srlat;
    const crlat2 = crlat * crlat;

    const a2 = A_WGS84 * A_WGS84;
    const b2 = B_WGS84 * B_WGS84;
    const c2 = a2 - b2;
    const a4 = a2 * a2;
    const b4 = b2 * b2;
    const c4 = a4 - b4;

    // Converte de coordenadas geodésicas (WGS84) para esféricas.
    const q = Math.sqrt(a2 - c2 * srlat2);
    const q1 = altKm * q;
    const q2 = ((q1 + a2) / (q1 + b2)) * ((q1 + a2) / (q1 + b2));
    const ct = srlat / Math.sqrt(q2 * crlat2 + srlat2);
    const st = Math.sqrt(1.0 - ct * ct);
    const r2 = altKm * altKm + 2.0 * q1 + (a4 - c4 * srlat2) / (q * q);
    const r = Math.sqrt(r2);
    const d = Math.sqrt(a2 * crlat2 + b2 * srlat2);
    const ca = (altKm + d) / r;
    const sa = (c2 * crlat * srlat) / (r * d);

    const sp = new Array(MAXORD + 1).fill(0);
    const cp = new Array(MAXORD + 1).fill(0);
    cp[0] = 1;
    sp[1] = srlon;
    cp[1] = crlon;
    for (let m = 2; m <= MAXORD; m++) {
      sp[m] = sp[1] * cp[m - 1] + cp[1] * sp[m - 1];
      cp[m] = cp[1] * cp[m - 1] - sp[1] * sp[m - 1];
    }

    const p = novaMatriz();
    const dp = novaMatriz();
    const tc = novaMatriz();
    p[0][0] = 1;
    const pp = new Array(MAXORD + 1).fill(0);
    pp[0] = 1;

    let br = 0,
      bt = 0,
      bp = 0,
      bpp = 0;
    const aor = RE / r;
    let ar = aor * aor;

    for (let n = 1; n <= MAXORD; n++) {
      ar *= aor;
      for (let m = 0, d4 = n + m + 1; d4 > 0; d4--, m++) {
        // Funções de Legendre associadas (não normalizadas) e derivadas, via recursão.
        if (n === m) {
          p[m][n] = st * p[m - 1][n - 1];
          dp[m][n] = st * dp[m - 1][n - 1] + ct * p[m - 1][n - 1];
        } else if (n === 1 && m === 0) {
          p[m][n] = ct * p[m][n - 1];
          dp[m][n] = ct * dp[m][n - 1] - st * p[m][n - 1];
        } else if (n > 1 && n !== m) {
          if (m > n - 2) {
            p[m][n - 2] = 0;
            dp[m][n - 2] = 0;
          }
          p[m][n] = ct * p[m][n - 1] - k[m][n] * p[m][n - 2];
          dp[m][n] = ct * dp[m][n - 1] - st * p[m][n - 1] - k[m][n] * dp[m][n - 2];
        }

        // Ajusta os coeficientes de Gauss para a data (epoch + variação secular).
        tc[m][n] = c[m][n] + dt * cd[m][n];
        if (m !== 0) tc[n][m - 1] = c[n][m - 1] + dt * cd[n][m - 1];

        // Acumula os termos da expansão em harmônicos esféricos.
        const par = ar * p[m][n];
        let temp1, temp2;
        if (m === 0) {
          temp1 = tc[m][n] * cp[m];
          temp2 = tc[m][n] * sp[m];
        } else {
          temp1 = tc[m][n] * cp[m] + tc[n][m - 1] * sp[m];
          temp2 = tc[m][n] * sp[m] - tc[n][m - 1] * cp[m];
        }
        bt -= ar * temp1 * dp[m][n];
        bp += fm[m] * temp2 * par;
        br += fn[n] * temp1 * par;

        // Caso especial: polos geográficos Norte/Sul.
        if (st === 0.0 && m === 1) {
          if (n === 1) pp[n] = pp[n - 1];
          else pp[n] = ct * pp[n - 1] - k[m][n] * pp[n - 2];
          const parp = ar * pp[n];
          bpp += fm[m] * temp2 * parp;
        }
      }
    }

    bp = st === 0.0 ? bpp : bp / st;

    // Roda os componentes do vetor magnético de esféricas para geodésicas.
    const bx = -bt * ca - br * sa;
    const by = bp;

    return rad2deg(Math.atan2(by, bx));
  }

  window.Declination = {
    getDeclination,
    WMM_EPOCH,
    WMM_VALID_ATE,
  };
})();
