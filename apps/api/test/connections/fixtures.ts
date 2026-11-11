export const AUDIT_12_2 = [
  "20261111 16:35:18,db-host,root,127.0.0.1:54551,4,0,CONNECT,,TLSv1.3,0",
  "20261111 16:35:18,db-host,root,127.0.0.1:54551,4,0,DISCONNECT,,TLSv1.3,0",
  "20261111 16:35:18,db-host,alpha_u,203.0.113.7:54552,5,0,FAILED_CONNECT,,TLSv1.3,1045",
  "20261111 16:35:18,db-host,alpha_u,203.0.113.7:54552,5,0,DISCONNECT,,TLSv1.3,0",
  "20261111 16:35:18,db-host,beta_u,203.0.113.7:54553,6,0,FAILED_CONNECT,,TLSv1.3,1045",
  "20261111 16:35:18,db-host,beta_u,203.0.113.7:54553,6,0,DISCONNECT,,TLSv1.3,0",
  "20261111 16:35:18,db-host,gamma_u,203.0.113.7:54554,7,0,FAILED_CONNECT,,TLSv1.3,4151",
  "20261111 16:35:18,db-host,gamma_u,203.0.113.7:54554,7,0,DISCONNECT,,TLSv1.3,0",
  "20261111 16:35:18,db-host,nobody,203.0.113.7:54555,8,0,FAILED_CONNECT,,TLSv1.3,1045",
  "20261111 16:35:18,db-host,nobody,203.0.113.7:54555,8,0,DISCONNECT,,TLSv1.3,0",
  "20261111 16:35:18,db-host,alpha_u,203.0.113.7:54556,9,0,FAILED_CONNECT,,TLSv1.3,1045",
  "20261111 16:35:18,db-host,alpha_u,203.0.113.7:54557,10,0,CONNECT,,TLSv1.3,0",
  "20261111 16:35:42,db-host,root,127.0.0.1:54562,13,0,FAILED_CONNECT,,TLSv1.3,1045",
];

export const ERRORLOG_12_2 = [
  "2026-11-11 16:34:57 0 [Note] mariadbd: ready for connections.",
  "Version: '12.2.2-MariaDB'  socket: '/tmp/ld/mariadb.sock'  port: 3420  Homebrew",
  "2026-11-11 16:35:18 5 [Warning] Access denied for user 'alpha_u'@'203.0.113.7' (using password: YES)",
  "2026-11-11 16:35:18 6 [Warning] Access denied for user 'beta_u'@'203.0.113.7' (using password: YES)",
  "2026-11-11 16:35:18 8 [Warning] Access denied for user 'nobody'@'203.0.113.7' (using password: YES)",
  "2026-11-11 16:35:18 9 [Warning] Access denied for user 'alpha_u'@'203.0.113.7' (using password: NO)",
  "2026-11-11 16:35:42 13 [Warning] Access denied for user 'root'@'127.0.0.1' (using password: YES)",
];

export const ERRORLOG_11_8 = [
  "2026-11-11 21:36:49 0 [Warning] failed to retrieve the MAC address",
  "2026-11-11 21:36:54 4 [Warning] Access denied for user 'alpha_u'@'198.51.100.23' (using password: YES)",
  "2026-11-11 21:36:54 5 [Warning] Access denied for user 'beta_u'@'198.51.100.23' (using password: YES)",
  "2026-11-11 21:36:54 7 [Warning] Access denied for user 'nobody'@'198.51.100.23' (using password: YES)",
  "2026-11-11 21:36:54 8 [Warning] Access denied for user 'alpha_u'@'198.51.100.23' (using password: NO)",
];
