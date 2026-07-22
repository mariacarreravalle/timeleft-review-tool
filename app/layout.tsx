import './globals.css'
import PasswordGate from './components/PasswordGate'

export const metadata = {
  title: 'Timeleft Review Analyser',
  description: 'Analyse app store reviews for themes, sentiment, and trends',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en-GB">
      <body>
        <PasswordGate>{children}</PasswordGate>
      </body>
    </html>
  )
}
